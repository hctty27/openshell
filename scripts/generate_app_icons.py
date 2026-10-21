"""Generate Windows icon resources from the approved OpenShell AI PNG."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "build" / "appicon.png"
ICON = ROOT / "build" / "windows" / "icon.ico"
FAVICON = ROOT / "frontend" / "public" / "app-icon.png"

def main() -> None:
    with Image.open(SOURCE) as original:
        image = original.convert("RGBA")
    if image.width != image.height or image.width < 128:
        raise ValueError("The source icon must be square and at least 128px")
    image = image.resize((1024, 1024), Image.Resampling.LANCZOS)
    image.save(SOURCE, optimize=True)
    ICON.parent.mkdir(parents=True, exist_ok=True)
    image.save(ICON, format="ICO",
               sizes=[(size, size) for size in (16, 24, 32, 48, 64, 128, 256)])
    FAVICON.parent.mkdir(parents=True, exist_ok=True)
    image.resize((256, 256), Image.Resampling.LANCZOS).save(FAVICON, optimize=True)
    print("Generated OpenShell AI appicon.png, Windows icon.ico and favicon")

if __name__ == "__main__":
    main()
