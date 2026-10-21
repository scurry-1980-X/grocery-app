#!/usr/bin/env python3
"""Task #1: offline preflight only. No services, SQL or cleanup implementation."""
import importlib.util
import json
import os
from pathlib import Path
import sys

SAFETY_PATH = Path(__file__).resolve().parents[1] / 'tests/supabase_integration/support/safety.py'
SPEC = importlib.util.spec_from_file_location('grocery_integration_safety', SAFETY_PATH)
safety = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = safety
SPEC.loader.exec_module(safety)


def main(argv=None, environment=None):
    args = sys.argv[1:] if argv is None else argv
    if args == ['--help']:
        print('Usage: run_supabase_integration.py preflight\n'
              'Offline only. No configuration arguments, services, connections or cleanup.')
        return 0
    if args != ['preflight']:
        print('Rejected arguments. Only offline preflight is supported; no connection or credential inputs.', file=sys.stderr)
        return 2
    try:
        result = safety.offline_preflight(os.environ if environment is None else environment)
    except safety.SafetyError:
        print('Preflight rejected unsafe environment. No external actions were performed.', file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
