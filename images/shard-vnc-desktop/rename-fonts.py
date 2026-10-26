"""Re-register faces under the Windows families they stand in for.

Latin faces are metric-compatible replacements. Every other script maps to the
font Windows itself uses for it (Nirmala UI for Indic, Microsoft YaHei for
Simplified Chinese, ...), so a page enumerating fonts sees an inbox Windows set
and no Linux family name.
"""
import pathlib, sys
from fontTools.ttLib import TTFont, TTCollection

FAMILIES = {
    'Liberation Sans': 'Arial', 'Liberation Sans Narrow': 'Arial Narrow',
    'Liberation Serif': 'Times New Roman', 'Liberation Mono': 'Courier New',
    'Carlito': 'Calibri', 'Caladea': 'Cambria',
    'Noto Sans Arabic': 'Segoe UI', 'Noto Sans Hebrew': 'Segoe UI',
    'Noto Sans Thai': 'Leelawadee UI', 'Noto Sans Lao': 'Leelawadee UI', 'Noto Sans Khmer': 'Leelawadee UI',
    'Noto Sans Myanmar': 'Myanmar Text',
    'Noto Sans Georgian': 'Sylfaen', 'Noto Sans Armenian': 'Sylfaen',
    'Noto Sans Ethiopic': 'Nyala',
    'Noto Serif Tibetan': 'Microsoft Himalaya',
    'Noto Sans Mongolian': 'Mongolian Baiti',
    'Noto Sans Cherokee': 'Gadugi', 'Noto Sans Canadian Aboriginal': 'Gadugi',
    'Noto Sans Syriac': 'Estrangelo Edessa',
    'Noto Sans Thaana': 'MV Boli',
    'Noto Sans NKo': 'Ebrima', 'Noto Sans Vai': 'Ebrima', 'Noto Sans Adlam Unjoined': 'Ebrima',
    'Noto Sans Osmanya': 'Ebrima', 'Noto Sans Tifinagh': 'Ebrima',
    'Noto Sans Yi': 'Microsoft Yi Baiti',
    'Noto Sans Ogham': 'Segoe UI Historic', 'Noto Sans Runic': 'Segoe UI Historic',
    'Noto Sans Math': 'Cambria Math',
    'Noto Sans Symbols': 'Segoe UI Symbol', 'Noto Sans Symbols 2': 'Segoe UI Symbol',
    'Noto Color Emoji': 'Segoe UI Emoji',
    'Noto Sans CJK SC': 'Microsoft YaHei',
    'Noto Sans CJK TC': 'Microsoft JhengHei', 'Noto Sans CJK HK': 'Microsoft JhengHei',
    'Noto Sans CJK JP': 'Yu Gothic UI', 'Noto Sans CJK KR': 'Malgun Gothic',
    'Noto Sans Mono CJK SC': 'SimSun', 'Noto Sans Mono CJK TC': 'MingLiU',
    'Noto Sans Mono CJK HK': 'MingLiU', 'Noto Sans Mono CJK JP': 'MS Gothic',
    'Noto Sans Mono CJK KR': 'Gulim',
}
for script in ('Devanagari', 'Bengali', 'Gujarati', 'Gurmukhi', 'Kannada', 'Malayalam',
               'Oriya', 'Tamil', 'Telugu', 'Sinhala'):
    FAMILIES[f'Noto Sans {script}'] = 'Nirmala UI'


def rename(font):
    """Rename one face in place; False when it is not one we ship."""
    names = font['name']
    family = names.getDebugName(16) or names.getDebugName(1)
    if family not in FAMILIES:
        return False
    target = FAMILIES[family]
    style = names.getDebugName(17) or names.getDebugName(2) or 'Regular'
    full = target if style == 'Regular' else f'{target} {style}'
    values = {1: target, 2: style, 3: full, 4: full, 6: f"{target.replace(' ', '')}-{style.replace(' ', '')}", 16: target, 17: style}
    for record in names.names:
        if record.nameID in values:
            record.string = values[record.nameID]
    names.names = [record for record in names.names if record.nameID != 18]
    return True


out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
for src in map(pathlib.Path, sys.argv[2:]):
    if src.suffix.lower() == '.ttc':
        collection = TTCollection(src)
        if any([rename(font) for font in collection.fonts]):
            collection.save(out / src.name)
        continue
    font = TTFont(src)
    if rename(font):
        font.save(out / src.name)
