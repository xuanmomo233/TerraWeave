"""Generate desktop icon containers and web sizes from the transparent RGBA master."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1]
icons = root / "src-tauri" / "icons"
master = Image.open(icons / "terraweave-master.png").convert("RGBA")
if master.width != master.height or master.getpixel((0, 0))[3] != 0:
    raise ValueError("Expected a square master with transparent corners")
def resized(size):
    return master.resize((size, size), Image.Resampling.LANCZOS)

resized(256).save(icons / "icon.ico", sizes=[(s,s) for s in (16,20,24,32,40,48,64,128,256)])
resized(1024).save(icons / "icon.icns", format="ICNS")
resized(256).save(icons / "icon.png")
web = root / "public"
web.mkdir(exist_ok=True)
resized(48).save(web / "terraweave.png")

