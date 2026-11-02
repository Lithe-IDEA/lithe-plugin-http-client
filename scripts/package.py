"""Package the already-built release executable and pinned dependency notices."""
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import zipfile

root = Path(__file__).resolve().parents[1]
metadata = json.loads(subprocess.check_output(["cargo", "metadata", "--locked", "--format-version", "1", "--filter-platform", "aarch64-apple-darwin"], cwd=root, timeout=60))
destination = root / "dist"
destination.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir=destination) as temporary:
    manifest = json.loads((root / "plugin.json").read_text())
    package = Path(temporary) / manifest["id"]
    (package / "bin").mkdir(parents=True)
    binary = package / "bin/lithe-http-client"
    subprocess.run(["lipo", "-create", str(root / "target/release/lithe-http-client"),
                    str(root / "target/x86_64-apple-darwin/release/lithe-http-client"),
                    "-output", str(binary)], check=True, timeout=30)
    assert set(subprocess.check_output(["lipo", "-archs", str(binary)], timeout=10).decode().split()) == {"arm64", "x86_64"}
    if platform.system() == "Darwin":
        subprocess.run(["codesign", "--force", "--sign", "-", "--timestamp=none", str(binary)], check=True, timeout=30)
    subprocess.run(["codesign", "--verify", "--strict", str(binary)], check=True, timeout=30)
    for name in ["LICENSE", "NOTICE", "CHANGELOG.md"]:
        shutil.copy2(root / name, package)
    shutil.copy2(root / "plugin.json", package)
    shutil.copy2(root / "README.md", package)
    shutil.copytree(root / "ui", package / "ui")
    shutil.copytree(root / "assets", package / "assets")
    licenses = package / "licenses"
    licenses.mkdir()
    records = []
    resolved = {node["id"] for node in metadata["resolve"]["nodes"]}
    for dependency in metadata["packages"]:
        if dependency["name"] == "lithe-http-client" or dependency["id"] not in resolved:
            continue
        folder = Path(dependency["manifest_path"]).parent
        target = licenses / f'{dependency["name"]}-{dependency["version"]}'
        target.mkdir(exist_ok=True)
        # Workspace members inherit their licenses from their repository root.
        candidates = [folder]
        if dependency["source"] and dependency["source"].startswith("git+"):
            candidates += list(folder.parents)[:3]
        copied = set()
        for candidate in candidates:
            for pattern in ("LICENSE*", "LICENCE*", "COPYING*", "NOTICE*", "THIRD_PARTY_LICENSES*"):
                for path in candidate.glob(pattern):
                    if path.is_file() and path.name not in copied:
                        shutil.copy2(path, target / path.name)
                        copied.add(path.name)
        if not copied:
            name = "specta" if dependency["name"].startswith("specta") else dependency["name"]
            supplement = root / "licenses" / f"{name}.txt"
            if supplement.is_file():
                shutil.copy2(supplement, target / "LICENSE")
                copied.add("LICENSE")
            else:
                raise RuntimeError(f"Missing license text: {dependency['name']}")
        records.append({"name": dependency["name"], "version": dependency["version"], "source": dependency["source"], "license": dependency["license"], "notices": sorted(copied)})
    (package / "DEPENDENCIES.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    (package / "UPSTREAM.json").write_text(json.dumps({
        "openidea": "3be40bd57c5718df39977c5f8b5d31f0ff3e692a",
        "lithePluginSdk": "e689971c000c15a044df0502052fe7b2c1c6f84f",
        "cargoLockSha256": hashlib.sha256((root / "Cargo.lock").read_bytes()).hexdigest(),
        "upstreamModifications": [],
    }, indent=2) + "\n")
    final = destination / manifest["id"]
    if final.exists():
        shutil.rmtree(final)
    shutil.move(str(package), final)
archive = destination / f"http-client-{manifest['version']}-darwin.zip"
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, strict_timestamps=False) as output:
    for path in sorted(final.rglob("*")):
        if path.is_file():
            output.write(path, path.relative_to(final.parent))
archive.with_suffix(".zip.sha256").write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name + "\n")
print(archive)
