## translate/

Translate `.pdf`, `.docx`, and `.doc` files from Slovenian to English and write new files with an `-eng` postfix.

### Setup

From the repo root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r translate/requirements.txt
```

### OpenAI translation (recommended)

Set your key:

```bash
export OPENAI_API_KEY="..."
```

Run (translates all supported files in a folder, recursively):

```bash
python translate/translate_files.py --input-dir "/path/to/folder"
```

### Output behavior

- `.docx` → writes a translated `.docx` next to the input: `name-eng.docx`
- `.pdf` → writes a translated PDF by default: `name-eng.pdf` (simple text PDF)
- `.doc` → attempts to convert to `.docx` using LibreOffice (`soffice`), then writes: `name-eng.docx`

### Notes / limitations

- PDF output is a **simple text PDF**, not a layout-preserving rebuild of the original PDF.
- `.doc` requires LibreOffice CLI (`soffice`) to be installed and available on PATH.
- For a single large document, speed comes mostly from `--chunk-workers` (parallel API calls per document).
- If you want offline translation, you can install Argos Translate + a Slovenian→English model; see the script help for details.


