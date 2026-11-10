"""Remove reviewed frame spill from the existing whale atlas without redrawing it.

Run with the bundled Python/Pillow runtime. The source hash pins the reviewed
asset, so these masks cannot silently be applied to a different illustration.
"""
import argparse
from collections import deque
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageFilter

SOURCE_SHA256 = '877cc8f424671394dab13d35fa18072f48b0905194ca3d5fb5b37b7807b080fa'
COUNTS = [7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]
# Half-open, local pixel rectangles, reviewed against the 192x208 source cells.
# These foreign fragments touch the hair/tail and survive component-only cleanup.
SPILL = {
    (3, 1): (16, 112, 27, 150),
    (3, 2): (165, 108, 176, 145),
    (6, 1): (23, 121, 33, 151),
    (8, 1): (22, 142, 45, 181),
    (8, 3): (24, 135, 30, 162),
}


def components(alpha):
    seen = bytearray(len(alpha))
    parts = []
    for start, value in enumerate(alpha):
        if not value or seen[start]:
            continue
        seen[start] = 1
        queue, pixels = deque([start]), []
        while queue:
            index = queue.popleft()
            pixels.append(index)
            x, y = index % 192, index // 192
            for yy in range(max(0, y - 1), min(208, y + 2)):
                for xx in range(max(0, x - 1), min(192, x + 2)):
                    neighbor = yy * 192 + xx
                    if alpha[neighbor] and not seen[neighbor]:
                        seen[neighbor] = 1
                        queue.append(neighbor)
        parts.append(pixels)
    return sorted(parts, key=len, reverse=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    if hashlib.sha256(args.source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise RuntimeError('Source differs from the reviewed atlas; inspect it before applying masks.')
    original = Image.open(args.source).convert('RGBA')
    if original.size != (1536, 2288):
        raise RuntimeError('Expected a 1536x2288 atlas.')
    atlas = original.copy()
    changes = []
    for row, count in enumerate(COUNTS):
        for column in range(count):
            box = (column * 192, row * 208, (column + 1) * 192, (row + 1) * 208)
            cell = atlas.crop(box)
            removed = 0
            if (row, column) in SPILL:
                left, top, right, bottom = SPILL[row, column]
                for y in range(top, bottom):
                    for x in range(left, right):
                        if cell.getpixel((x, y))[3]:
                            removed += 1
                        cell.putpixel((x, y), (0, 0, 0, 0))
            noise = 0
            if row < 9:
                alpha = cell.getchannel('A').tobytes()
                parts = components(alpha)
                main_mask = bytearray(192 * 208)
                for index in parts[0]:
                    main_mask[index] = 255
                mask = Image.frombytes('L', (192, 208), bytes(main_mask))
                near = mask.filter(ImageFilter.MaxFilter(7)).tobytes()
                # Remove only extremely faint, isolated residue far from the
                # character. Real detached outline details near it are kept.
                for part in parts[1:]:
                    if max(alpha[index] for index in part) <= 16 and not any(near[index] for index in part):
                        for index in part:
                            cell.putpixel((index % 192, index // 192), (0, 0, 0, 0))
                        noise += len(part)
            if removed or noise:
                changes.append({'row': row, 'column': column, 'spill_pixels': removed,
                                'faint_residue_pixels': noise, 'mask': SPILL.get((row, column))})
            atlas.paste(cell, box[:2])
    # Hidden RGB has no visual meaning; use a canonical transparent background.
    atlas.putdata([pixel if pixel[3] else (0, 0, 0, 0) for pixel in atlas.getdata()])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(args.output, format='WEBP', lossless=True, exact=True, method=6)
    decoded = Image.open(args.output).convert('RGBA')
    assert decoded.tobytes() == atlas.tobytes(), 'Encoding changed the repaired pixels.'
    added = changed_kept = look_changes = 0
    for index, (old, new) in enumerate(zip(original.getdata(), decoded.getdata())):
        added += new[3] > old[3]
        changed_kept += bool(new[3] and new != old)
        if index // 1536 >= 9 * 208:
            look_changes += bool(old[3] != new[3] or (old[3] and old != new))
    assert not (added or changed_kept or look_changes), 'Repair altered retained artwork.'
    report = {'source_sha256': SOURCE_SHA256, 'output_sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(),
              'size': list(decoded.size), 'inspected_cells': sum(COUNTS), 'changes': changes,
              'removed_spill_pixels': sum(item['spill_pixels'] for item in changes),
              'removed_faint_residue_pixels': sum(item['faint_residue_pixels'] for item in changes),
              'added_pixels': added, 'changed_retained_pixels': changed_kept,
              'changed_visible_look_pixels': look_changes}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key != 'changes'}))


if __name__ == '__main__':
    main()
