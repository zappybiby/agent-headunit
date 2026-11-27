import os
import sys
from pathlib import Path

PACKAGE_ROOT = Path(os.environ.get("HEADUNIT_TEST_PACKAGE") or Path(__file__).resolve().parents[1])
sys.path[:0] = [str(PACKAGE_ROOT / "backend"), str(PACKAGE_ROOT / "windows"), str(PACKAGE_ROOT)]
