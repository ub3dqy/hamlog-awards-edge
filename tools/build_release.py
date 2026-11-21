"""Build desktop browser packages from the checked-out extension."""

import argparse
import hashlib
import json
import struct
import subprocess
from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
FILES = (
    'README.md', 'callsign.js', 'certificate-archive.js', 'options.css', 'options.html',
    'options.js', 'popup.css', 'popup.html', 'popup.js', 'runner.js', 'site-adapter.js',
    'update-service.js', 'updates.js',
)


def members(manifest):
    yield 'manifest.json', (json.dumps(manifest, indent=2, ensure_ascii=False) + '\n').encode()
    for name in FILES:
        path = ROOT / name
        if path.resolve() != path:
            raise ValueError(f'Unexpected package file path: {name}')
        yield name, path.read_bytes()


def build_zip(manifest):
    buffer = BytesIO()
    with ZipFile(buffer, 'w') as archive:
        for name, data in members(manifest):
            archive.writestr(ZipInfo(name, (2020, 1, 1, 0, 0, 0)), data, ZIP_DEFLATED)
    return buffer.getvalue()


def varint(value):
    octets = bytearray()
    while value >= 128:
        octets.append((value & 127) | 128)
        value >>= 7
    octets.append(value)
    return bytes(octets)


def proto_bytes(field, data):
    return varint((field << 3) | 2) + varint(len(data)) + data


def build_crx(zip_bytes, openssl, key):
    # CRX3 layout and RSA signature follow Chromium crx3.proto and crx_creator.cc.
    public = subprocess.run(
        [openssl, 'rsa', '-in', key, '-pubout', '-outform', 'DER'],
        check=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, timeout=15,
    ).stdout
    signed_header = proto_bytes(1, hashlib.sha256(public).digest()[:16])
    signed_data = b'CRX3 SignedData\0' + struct.pack('<I', len(signed_header)) + signed_header + zip_bytes
    signature = subprocess.run(
        [openssl, 'dgst', '-sha256', '-sign', key, '-sigopt', 'rsa_padding_mode:pkcs1'],
        check=True, input=signed_data, stdout=subprocess.PIPE, timeout=15,
    ).stdout
    proof = proto_bytes(1, public) + proto_bytes(2, signature)
    header = proto_bytes(2, proof) + proto_bytes(10000, signed_header)
    return struct.pack('<4sII', b'Cr24', 3, len(header)) + header + zip_bytes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--openssl', default='openssl', help='OpenSSL executable')
    parser.add_argument('--yandex-key', required=True, type=Path, help='Existing private PEM outside the repository')
    args = parser.parse_args()
    output = args.output.resolve()
    key = args.yandex_key.resolve(strict=True)
    if key.is_relative_to(ROOT) or key.is_relative_to(output):
        parser.error('Keep the signing key outside the repository and the output directory')

    base = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    firefox = dict(base, background={'scripts': ['updates.js', 'update-service.js']})
    firefox['browser_specific_settings'] = {'gecko': {
        'id': 'hamlog-awards@ub3dqy.com',
        'strict_min_version': '140.0',
        'data_collection_permissions': {'required': ['personallyIdentifyingInfo']},
    }}
    yandex = dict(base, version_name='Яндекс Браузер')
    packages = {
        'hamlog-awards-edge.zip': build_zip(base),
        'hamlog-awards-firefox.zip': build_zip(firefox),
        'hamlog-awards-yandex.crx': build_crx(build_zip(yandex), args.openssl, key),
    }
    output.mkdir(parents=True, exist_ok=False)
    checksums = []
    for name, data in packages.items():
        (output / name).write_bytes(data)
        checksums.append(f'{hashlib.sha256(data).hexdigest()}  {name}\n')
    (output / 'SHA256SUMS.txt').write_text(''.join(checksums), encoding='ascii', newline='\n')


if __name__ == '__main__':
    main()
