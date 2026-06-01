import glob

# Double-encoded dash bytes (UTF-8 bytes of mojibake chars):
# en-dash U+2013 (E2 80 93) misread as CP1252 then re-UTF8-encoded:
#   E2 -> U+00E2 -> C3 A2
#   80 -> U+20AC -> E2 82 AC
#   93 -> U+201C -> E2 80 9C
en_dash_bad = bytes([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xE2, 0x80, 0x9C])

# em-dash U+2014 (E2 80 94) misread as CP1252 then re-UTF8-encoded:
#   E2 -> U+00E2 -> C3 A2
#   80 -> U+20AC -> E2 82 AC
#   94 -> U+201D -> E2 80 9D
em_dash_bad = bytes([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xE2, 0x80, 0x9D])

# Correct em-dash U+2014 in UTF-8
em_dash_good = bytes([0xE2, 0x80, 0x94])

# Fix bathrooms.html
path = r'precision-remodel-site\bathrooms.html'
content = open(path, 'rb').read()
c1 = content.count(en_dash_bad)
c2 = content.count(em_dash_bad)
fixed = content.replace(en_dash_bad, em_dash_good).replace(em_dash_bad, em_dash_good)
open(path, 'wb').write(fixed)
print(f'bathrooms.html: replaced {c1} en-dash mojibake + {c2} em-dash mojibake')
if c1 + c2 == 0:
    # fallback: try raw string search for what Python actually found
    text = open(path, encoding='utf-8').read()
    import unicodedata
    suspects = []
    for i, ch in enumerate(text):
        if unicodedata.name(ch, '').startswith('LATIN SMALL LETTER A WITH CIRC') or ord(ch) == 0x00E2:
            suspects.append((i, repr(text[i:i+3])))
    print('Suspect sequences:', suspects[:10])

# Fix copyright year in all HTML files
html_files = glob.glob(r'precision-remodel-site\**\*.html', recursive=True)
total = 0
for fp in html_files:
    content = open(fp, encoding='utf-8').read()
    if '2024 Precision Remodel' in content:
        fixed = content.replace('2024 Precision Remodel', '2026 Precision Remodel')
        open(fp, 'w', encoding='utf-8').write(fixed)
        print(f'Copyright fixed: {fp}')
        total += 1
print(f'Copyright: {total} files updated')
