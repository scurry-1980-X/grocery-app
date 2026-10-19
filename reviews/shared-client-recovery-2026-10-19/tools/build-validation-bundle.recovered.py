#!/usr/bin/env python3
"""Build a local-only Mac helper bundle. Does not start it or contact Supabase."""
import json
import re
import shutil
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path('/workspace/attachments/grocery-live-validation').resolve()
out.mkdir(parents=True, exist_ok=True)
for name in ('runner.js', 'grocery-live-validation.py', 'START-HERE.txt'):
    shutil.copyfile(root / 'tools/live-validation' / name, out / name)
for source, name in [('mutation-protocol.js', 'mutation-protocol.js'),
                     ('vendor/supabase-2.118.0.js', 'supabase.js'),
                     ('vendor/SUPABASE-LICENSE', 'SUPABASE-LICENSE')]:
    # License name differs between vendor provenance versions.
    src = root / source
    if not src.exists() and name == 'SUPABASE-LICENSE':
        src = root / 'vendor/supabase-LICENSE'
    shutil.copyfile(src, out / name)
config = (root / 'shared-config.js').read_text()
values = {}
for field in ('url', 'publishableKey'):
    match = re.search(r"\b" + field + r"\s*:\s*['\"]([^'\"]+)['\"]", config)
    if not match:
        raise SystemExit('Public configuration format is unsupported; no bundle published.')
    values[field] = match.group(1)
if not values['publishableKey'].startswith('sb_publishable_'):
    raise SystemExit('Only a public publishable key is permitted.')
(out / 'public-config.json').write_text(json.dumps(values))
shutil.make_archive(str(out), 'zip', out.parent, out.name)
print('Built local validation bundle. It was not started; no network operations ran.')
