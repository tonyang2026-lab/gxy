"""Build a standalone ZIP without private data or unrelated repository projects."""
from pathlib import Path
import zipfile
root=Path(__file__).resolve().parent
out=root.parent/'downloads'/'Yuanben-Amazon-Template-Library.zip'
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted(root.rglob('*')):
        rel=p.relative_to(root)
        if not p.is_file() or any(part in ('data','__pycache__','docs') for part in rel.parts):
            continue
        data=p.read_bytes()
        if p.suffix=='.bat':data=data.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n')
        z.writestr('Yuanben-Amazon-Template-Library/'+rel.as_posix(),data)
print(out)
