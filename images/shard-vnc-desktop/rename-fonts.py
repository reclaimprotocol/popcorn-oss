"""Re-register metric-compatible faces under the Windows families they replace."""
import pathlib, sys
from fontTools.ttLib import TTFont

FAMILIES = {
    'Liberation Sans': 'Arial', 'Liberation Sans Narrow': 'Arial Narrow',
    'Liberation Serif': 'Times New Roman', 'Liberation Mono': 'Courier New',
    'Carlito': 'Calibri', 'Caladea': 'Cambria',
}
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
for src in sys.argv[2:]:
    font = TTFont(src)
    names = font['name']
    family = names.getDebugName(16) or names.getDebugName(1)
    if family not in FAMILIES:
        continue
    target = FAMILIES[family]
    for record in names.names:
        if record.nameID in (1, 3, 4, 6, 16, 18):
            text = record.toUnicode().replace(family, target)
            if record.nameID == 6:
                text = text.replace(family.replace(' ', ''), target.replace(' ', ''))
            record.string = text
    font.save(out / (target.replace(' ', '') + '-' + (names.getDebugName(2) or 'Regular').replace(' ', '') + '.ttf'))
