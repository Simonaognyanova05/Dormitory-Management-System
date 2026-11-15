# Python Preprocessing

Python scripts added in tasks 6–7 will convert PDF pages to images and prepare PDF/JPG/PNG inputs for extraction. They will be started by Node.js with `child_process.spawn()`; this directory is not a separate HTTP service.

## Environment

Use Python 3.10 or newer. Python 3.13 is available in the current development environment.

From the repository root in Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r python/requirements.txt
```

Then set this in the root `.env` when Python processing is implemented:

```dotenv
PYTHON_COMMAND=.venv/Scripts/python.exe
```

On Linux/macOS, use `python3 -m venv .venv`, `.venv/bin/python -m pip install -r python/requirements.txt`, and `PYTHON_COMMAND=.venv/bin/python`.

`opencv-python-headless` provides `cv2` without desktop GUI dependencies. PyMuPDF supplies PDF rendering, and Pillow handles image orientation, sizing, and format conversion. Compatible dependency ranges are specified in `requirements.txt`.

The current `/health` endpoint works independently of this Python setup. No preprocessing script is implemented yet.
