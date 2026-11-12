from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent
image = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.polygon([(32, 32), (846, 32), (992, 178), (992, 992), (32, 992)], fill='#0B0C0E')
draw.line([(94, 930), (930, 930), (930, 210)], fill='#2A2D34', width=8)
draw.polygon([(320, 254), (756, 254), (756, 346), (418, 346), (418, 458), (710, 458), (756, 504), (756, 768), (268, 768), (268, 672), (658, 672), (658, 558), (366, 558), (320, 512)], fill='#F0F2F5')
draw.rectangle((174, 254, 190, 768), fill='#FFFA00')
image.resize((256, 256), Image.Resampling.LANCZOS).save(root / 'icon.png')
image.save(root / 'icon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('Created icon.png and icon.ico')
