"""Remove the second reviewed waiting-frame tail residue from the repaired atlas."""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image

PARENT_SHA256 = '3a99033406ca271b1f8ab5270f567fef5c219977266f83bfb2285a79e9de4f50'
MASK = (6, 4, 20, 120, 33, 166)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    if hashlib.sha256(args.source.read_bytes()).hexdigest() != PARENT_SHA256:
        raise RuntimeError('Source does not match the reviewed 1.0.7 whale atlas.')
    original = Image.open(args.source).convert('RGBA')
    atlas = original.copy()
    row, col, left, top, right, bottom = MASK
    cell = atlas.crop((col * 192, row * 208, (col + 1) * 192, (row + 1) * 208))
    removed = 0
    for y in range(top, bottom):
        for x in range(left, right):
            if cell.getpixel((x, y))[3]: removed += 1
            cell.putpixel((x, y), (0, 0, 0, 0))
    atlas.paste(cell, (col * 192, row * 208))
    atlas.putdata([pixel if pixel[3] else (0, 0, 0, 0) for pixel in atlas.getdata()])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(args.output, format='WEBP', lossless=True, exact=True, method=6)
    decoded = Image.open(args.output).convert('RGBA')
    assert decoded.size == (1536, 2288)
    assert all(new[3] <= old[3] for old, new in zip(original.getdata(), decoded.getdata()))
    assert all(old == new for index, (old, new) in enumerate(zip(original.getdata(), decoded.getdata()))
               if index // 1536 >= 9 * 208)
    report = {
        'parent_sha256': PARENT_SHA256,
        'output_sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(),
        'size': list(decoded.size),
        'row': row, 'column': col, 'mask': [left, top, right, bottom],
        'removed_pixels': removed, 'look_frames_changed': 0,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))

if __name__ == '__main__':
    main()
