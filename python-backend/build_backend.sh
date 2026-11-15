#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Building the current backend with pinned dependencies..."
"${PDF_BUILD_PYTHON:-python3}" build_backend.py
echo "Done. Output: dist/python_backend"
