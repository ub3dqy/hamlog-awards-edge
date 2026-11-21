"""Build desktop browser packages from the checked-out extension."""

import argparse
import hashlib
import json
import struct
import subprocess
from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
MAX_XPI_BYTES = 8 * 1024**2
FIREFOX_ID = 'hamlog-awards@ub3dqy.com'
FIREFOX_MIN_VERSION = '140.0'
FIREFOX_RELEASES = 'https://github.com/ub3dqy/hamlog-awards-edge/releases'
FIREFOX_UPDATE_URL = f'{FIREFOX_RELEASES}/latest/download/updates.json'
FIREFOX_XPI = 'hamlog-awards-firefox.xpi'
REQUIRED_SIGNATURE_MEMBERS = {'META-INF/manifest.mf', 'META-INF/mozilla.sf', 'META-INF/mozilla.rsa'}
OPTIONAL_SIGNATURE_MEMBERS = {'META-INF/', 'META-INF/cose.manifest', 'META-INF/cose.sig', 'recommendation.json'}
FILES = (
    'README.md', 'callsign.js', 'certificate-archive.js', 'issued-progress.js', 'issued-service.js',
    'options.css', 'options.html',
    'options.js', 'popup.css', 'popup.html', 'popup.js', 'runner.js', 'site-adapter.js',
    'update-service.js', 'updates.js',
)


def members(manifest):
    yield 'manifest.json', (json.dumps(manifest, indent=2, ensure_ascii=False) + '\n').encode()
    for name in FILES:
        path = ROOT / name
        if path.resolve() != path:
            raise ValueError(f'Unexpected package file path: {name}')
        yield name, path.read_bytes().replace(b'\r\n', b'\n')


def build_zip(manifest):
    buffer = BytesIO()
    with ZipFile(buffer, 'w') as archive:
        for name, data in members(manifest):
            archive.writestr(ZipInfo(name, (2020, 1, 1, 0, 0, 0)), data, ZIP_DEFLATED)
    return buffer.getvalue()


def firefox_manifest(base):
    manifest = dict(base, background={'scripts': [
        'updates.js', 'callsign.js', 'certificate-archive.js', 'issued-progress.js',
        'issued-service.js', 'update-service.js',
    ]})
    manifest['browser_specific_settings'] = {'gecko': {
        'id': FIREFOX_ID,
        'strict_min_version': FIREFOX_MIN_VERSION,
        'update_url': FIREFOX_UPDATE_URL,
        'data_collection_permissions': {'required': ['personallyIdentifyingInfo', 'websiteContent']},
    }}
    return manifest


def firefox_updates(version, xpi):
    update = {
        'version': version,
        'update_link': f'{FIREFOX_RELEASES}/download/v{version}/{FIREFOX_XPI}',
        'update_hash': f'sha256:{hashlib.sha256(xpi).hexdigest()}',
        'applications': {'gecko': {'strict_min_version': FIREFOX_MIN_VERSION}},
    }
    return {'addons': {FIREFOX_ID: {'updates': [update]}}}


def read_signed_firefox(path, manifest):
    # The browser still needs to verify the signature before publication.
    if path.suffix.lower() != '.xpi':
        raise ValueError('Select the .xpi downloaded from Mozilla.')
    with path.open('rb') as source:
        data = source.read(MAX_XPI_BYTES + 1)
    if not data.startswith(b'PK\x03\x04') or len(data) > MAX_XPI_BYTES:
        raise ValueError('Invalid or oversized Firefox package.')
    expected = dict(members(manifest))
    with ZipFile(BytesIO(data)) as archive:
        names = archive.namelist()
        entries = set(names)
        if (len(names) != len(entries) or not REQUIRED_SIGNATURE_MEMBERS <= entries
                or entries - REQUIRED_SIGNATURE_MEMBERS - OPTIONAL_SIGNATURE_MEMBERS != expected.keys()
                or any(archive.getinfo(name).file_size == 0 for name in REQUIRED_SIGNATURE_MEMBERS)):
            raise ValueError('Unexpected Firefox package members or missing Mozilla signature files.')
        # Mozilla can reformat the manifest during signing, so compare the parsed JSON.
        filename = 'manifest.json'
        if not 0 < archive.getinfo(filename).file_size <= 64 * 1024:
            raise ValueError('Invalid signed Firefox manifest size.')
        signed_manifest = json.loads(archive.read(filename))
        if json.dumps(signed_manifest, sort_keys=True) != json.dumps(manifest, sort_keys=True):
            raise ValueError('The signed Firefox manifest differs from the source checkout.')
        del expected[filename]
        for name, contents in expected.items():
            if archive.getinfo(name).file_size != len(contents) or archive.read(name) != contents:
                raise ValueError(f'Firefox package differs from the source checkout: {name}')
    return data


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
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--firefox-only', action='store_true', help='Build the unsigned ZIP for Mozilla')
    mode.add_argument('--signed-firefox', type=Path, help='Mozilla-signed XPI for a full release')
    parser.add_argument('--yandex-key', type=Path, help='Existing private PEM outside the repository')
    args = parser.parse_args()
    output = args.output.resolve()
    base = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    firefox = firefox_manifest(base)
    if args.firefox_only:
        packages = {'hamlog-awards-firefox.zip': build_zip(firefox)}
    else:
        if not args.yandex_key:
            parser.error('--yandex-key is required for a full release')
        key = args.yandex_key.resolve(strict=True)
        if key.is_relative_to(ROOT) or key.is_relative_to(output):
            parser.error('Keep the signing key outside the repository and the output directory')
        try:
            firefox_xpi = read_signed_firefox(args.signed_firefox, firefox)
        except (BadZipFile, OSError, ValueError) as error:
            parser.error(str(error))
        yandex = dict(base, version_name='Яндекс Браузер')
        packages = {
            'hamlog-awards-edge.zip': build_zip(base),
            FIREFOX_XPI: firefox_xpi,
            'hamlog-awards-yandex.crx': build_crx(build_zip(yandex), args.openssl, key),
        }
    output.mkdir(parents=True, exist_ok=False)
    checksums = []
    for name, data in packages.items():
        (output / name).write_bytes(data)
        checksums.append(f'{hashlib.sha256(data).hexdigest()}  {name}\n')
    (output / 'SHA256SUMS.txt').write_text(''.join(checksums), encoding='ascii', newline='\n')
    if not args.firefox_only:
        updates = firefox_updates(base['version'], firefox_xpi)
        (output / 'updates.json').write_text(json.dumps(updates, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
