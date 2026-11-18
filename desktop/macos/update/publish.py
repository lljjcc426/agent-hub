"""Publish a signed Roppo update to this Mac's local Sparkle channel."""
import argparse
import fcntl
import os
import plistlib
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from email.utils import formatdate
from pathlib import Path

ACCOUNT = "com.roppo.studio.desktop.updates"
SPARKLE = "http://www.andymatuschak.org/xml-namespaces/sparkle"
ET.register_namespace("sparkle", SPARKLE)


def version_tuple(version):
    if not version or not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError(f"Expected a numeric major.minor.patch version, got {version!r}")
    return tuple(map(int, version.split(".")))


def publish(app, directory, tools):
    meta = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    version = meta["CFBundleShortVersionString"]
    new_version = version_tuple(version)
    if app.name != "Roppo.app" or meta["CFBundleIdentifier"] != "com.roppo.studio.desktop" or meta["CFBundleVersion"] != version:
        raise ValueError("Unexpected application identity or build number")
    subprocess.run(["codesign", "--verify", "--deep", "--strict", app], check=True)
    subprocess.run(["lipo", app / "Contents/MacOS/Roppo", "-verify_arch", "arm64"], check=True)
    key = subprocess.check_output([tools / "generate_keys", "--account", ACCOUNT, "-p"], text=True).strip()
    if key != meta.get("SUPublicEDKey") or meta.get("SURequireSignedFeed") is not True:
        raise ValueError("The app must trust this channel's signing key and require a signed feed")
    signer = [tools / "sign_update", "--account", ACCOUNT]
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    feed = directory / "appcast.xml"
    with (directory / ".publish.lock").open("a") as lock, tempfile.TemporaryDirectory(dir=directory) as temp:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if feed.exists():
            subprocess.run([*signer, "--verify", feed], check=True)
            previous = ET.parse(feed).findtext(f"./channel/item/{{{SPARKLE}}}version")
            if new_version <= version_tuple(previous):
                raise ValueError(f"Release {version} must be newer than {previous}")
        filename = f"Roppo-{version}-arm64.zip"
        archive = Path(temp) / filename
        subprocess.run(["ditto", "-c", "-k", "--keepParent", "--sequesterRsrc", app, archive], check=True)
        signature = subprocess.check_output([*signer, "-p", archive], text=True).strip()
        subprocess.run([*signer, "--verify", archive, signature], check=True)
        root = ET.Element("rss", version="2.0")
        channel = ET.SubElement(root, "channel")
        ET.SubElement(channel, "title").text = "Roppo"
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = "Roppo " + version
        ET.SubElement(item, "pubDate").text = formatdate(usegmt=True)
        ET.SubElement(item, f"{{{SPARKLE}}}version").text = version
        ET.SubElement(item, f"{{{SPARKLE}}}shortVersionString").text = version
        ET.SubElement(item, "enclosure", url=filename, length=str(archive.stat().st_size),
                      type="application/octet-stream", attrib={f"{{{SPARKLE}}}edSignature": signature})
        staged_feed = Path(temp) / feed.name
        ET.ElementTree(root).write(staged_feed, encoding="utf-8", xml_declaration=True)
        subprocess.run([*signer, staged_feed], check=True)
        subprocess.run([*signer, "--verify", staged_feed], check=True)
        # Readers see the complete old release until its verified successor is available.
        os.replace(archive, directory / filename)
        os.replace(staged_feed, feed)
    print(f"Published Roppo {version} to {directory}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    args = parser.parse_args()
    sdk = Path(os.environ["ROPPO_SPARKLE_SDK"]) if os.environ.get("ROPPO_SPARKLE_SDK") else Path(__file__).resolve().parents[3] / ".local/sparkle-2.10.1"
    if not (sdk / "bin/sign_update").is_file():
        parser.error("Set ROPPO_SPARKLE_SDK to the extracted Sparkle SDK directory")
    publish(args.app.resolve(), Path.home() / "Library/Application Support/Roppo Updates/releases", sdk.resolve() / "bin")
