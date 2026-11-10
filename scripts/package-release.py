"""Assemble the Windows distribution without including personal configuration."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import zipfile


def main():
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-dir', type=Path, default=root / 'dist/win-unpacked')
    parser.add_argument('--output', type=Path, default=root / 'dist')
    args = parser.parse_args()
    source, output = args.app_dir.resolve(), args.output.resolve()
    version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
    stem = f'DragonDesk-{version}-windows-x64'
    destination, archive = output / stem / 'DragonDesk', output / f'{stem}.zip'
    if destination.parent.exists() or archive.exists():
        raise RuntimeError('Distribution already exists; choose a fresh version or output directory.')
    if not (source / 'DragonDesk.exe').is_file():
        raise RuntimeError('Build DragonDesk.exe before packaging.')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip():
        raise RuntimeError('Commit source changes before assembling a release.')

    # Inspect the actual archive that will ship, not the developer's sample file.
    with (source / 'resources/app.asar').open('rb') as handle:
        prefix = handle.read(16)
        index = json.loads(handle.read(struct.unpack('<I', prefix[12:16])[0]))
        data_start = 8 + struct.unpack('<I', prefix[4:8])[0]
        def entry(name):
            node = index
            for part in name.split('/'):
                node = node['files'][part]
            handle.seek(data_start + int(node['offset']))
            return handle.read(node['size'])
        bundled_package = json.loads(entry('package.json'))
        example = json.loads(entry('config.example.json'))
        if bundled_package['version'] != version:
            raise RuntimeError('Executable resources do not match the release version.')
        if any(item.get('apiKey') for item in example['providers'].values()):
            raise RuntimeError('Bundled example contains an API key.')
        if example['startup']['enabled']:
            raise RuntimeError('Default distribution must not enable auto-start.')
        forbidden = {'config.json', 'data', 'work', '.env', '.git'}
        if forbidden.intersection(index['files']):
            raise RuntimeError('Private or development files found in app resources.')

    if any(item.name in {'config.json', 'data', '.env', '.git', 'work'} for item in source.iterdir()):
        raise RuntimeError('Build directory contains personal or development files.')
    shutil.copytree(source, destination)
    licenses = destination / '许可与来源'
    licenses.mkdir()
    for original, name in [
        ('LICENSE', '软件-MIT.txt'),
        ('assets/ATTRIBUTION.md', '素材来源.md'),
        ('assets/ARTWORK-LICENSE.txt', '龙娘素材许可.txt'),
        ('assets/whale/LICENSE.txt', '鲸鱼娘素材许可.txt'),
    ]:
        shutil.copyfile(root / original, licenses / name)
    shutil.copyfile(root / 'config.example.json', destination / 'config.example.json')
    guide = f'''DragonDesk {version} · Windows x64

1. 解压并保留整个 DragonDesk 文件夹，双击 DragonDesk.exe 启动。
2. 不需要安装 Node.js、Python 或 Codex。首次启动会自动生成 config.json。
3. 双击桌宠打开聊天；右键 → 设置与性格，填写 API Key、接口地址和模型。
4. 默认 Alt + X 切换显示/隐藏，可在设置中用键盘录入其他组合。
5. 开机自启默认关闭，可在设置中打开；退出使用托盘 → 退出 DragonDesk。
6. 可选的 DSH / ChatGPT 状态监听默认关闭，需要时在设置中启用。

升级：先从托盘退出旧版。将旧版的 config.json 与 data 文件夹保留到新版
DragonDesk.exe 同级目录，即可继续使用原配置和聊天记录。不要分享含密钥的配置。

本包只包含空白示例，不包含作者的密钥、聊天历史或个人数据。
许可和素材来源见“许可与来源”目录；Electron / Chromium 许可保留在程序同级。
源码与版本发布：https://github.com/hl-qingyu/pet
源码提交：{commit}
'''
    (destination / '使用说明.txt').write_text(guide, encoding='utf-8-sig')
    (destination / '版本信息.json').write_text(json.dumps({
        'version': version, 'platform': 'windows-x64', 'commit': commit,
        'repository': 'https://github.com/hl-qingyu/pet',
    }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as package:
        for file in sorted(destination.rglob('*')):
            if file.is_file():
                package.write(file, file.relative_to(destination.parent).as_posix())
    with zipfile.ZipFile(archive) as package:
        if package.testzip() is not None:
            raise RuntimeError('ZIP integrity check failed.')
        names = package.namelist()
        if any(name.endswith('/config.json') or '/data/' in name for name in names):
            raise RuntimeError('Personal files found in distribution ZIP.')
        if 'DragonDesk/许可与来源/素材来源.md' not in names:
            raise RuntimeError('Attribution is missing from the distribution.')
    digest = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
    checksum = output / f'{stem}.zip.sha256'
    checksum.write_text(f'{digest}  {archive.name}\n', encoding='ascii')
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size,
                      'sha256': digest, 'checksum': str(checksum),
                      'folder': str(destination), 'commit': commit}, indent=2))


if __name__ == '__main__':
    main()

