#!/usr/bin/env python3
"""Render saved test outputs as monochrome evidence exhibits for the PDF report."""

import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "preuves"
CAPTURES = EVIDENCE / "captures"
CAPTURES.mkdir(parents=True, exist_ok=True)
FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_BOLD_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
FONT = ImageFont.truetype(FONT_PATH, 22)
SMALL = ImageFont.truetype(FONT_PATH, 18)
TITLE = ImageFont.truetype(FONT_BOLD_PATH, 27)


def wrap(lines, width=132):
    output = []
    for line in lines:
        while len(line) > width:
            output.append(line[:width])
            line = "  " + line[width:]
        output.append(line)
    return output


def render(filename, title, source, lines):
    lines = wrap(lines)
    width = 2100
    top = 35
    line_height = 31
    height = top + 55 + 35 + 35 + len(lines) * line_height + 35
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((24, 24, width - 24, height - 24), outline="black", width=2)
    draw.text((52, 48), title, font=TITLE, fill="black")
    draw.text((52, 96), source, font=SMALL, fill="black")
    y = 142
    draw.line((52, y - 10, width - 52, y - 10), fill="black", width=1)
    for line in lines:
        draw.text((52, y), line, font=FONT, fill="black")
        y += line_height
    image.save(CAPTURES / filename, dpi=(180, 180), optimize=True)


build = (EVIDENCE / "build.log").read_text(encoding="utf-8").splitlines()
render("compilation.png", "Preuve visuelle — compilation", "Source : preuves/build.log (sortie de npm run build)", build[-14:])

tap = (EVIDENCE / "integration.tap.log").read_text(encoding="utf-8").splitlines()
integration_lines = [line for line in tap if line.startswith("# Subtest:") or line.startswith("ok ") or line.startswith("# tests ") or line.startswith("# pass ") or line.startswith("# fail ") or line.startswith("# skipped ") or line.startswith("# duration_ms ")]
render("integration.png", "Preuve visuelle — tests d’intégration", "Source : preuves/integration.tap.log (résumé extrait de la sortie TAP)", integration_lines)

load = json.loads((EVIDENCE / "charge-locale.json").read_text(encoding="utf-8"))
load_lines = [f"Date : {load['date']}    Cible : {load['target']}", ""]
for item in load["http"]:
    p = item["latency_ms"]
    load_lines.extend([
        f"{item['scenario']} — {item['requests']} requêtes; concurrence {item['concurrency']}; HTTP 200 : {item['statuses'].get('200', 0)}",
        f"Débit : {item['requests_per_second']} req/s; latences p50/p95/p99 : {p['p50']} / {p['p95']} / {p['p99']} ms",
        "",
    ])
ws = load["websocket"]
p = ws["latency_ms"]
load_lines.extend([
    f"WebSocket — {ws['connections_requested']} connexions; sync reçues : {ws['initial_sync_received']}; échecs : {ws['failures']}",
    f"Durée : {ws['elapsed_ms']} ms; connexions/s : {ws['connections_per_second']}; p50/p95/p99 : {p['p50']} / {p['p95']} / {p['p99']} ms",
    f"Note de périmètre : {ws['identity_count']} identité de test; lecture HTTP et ouverture WS seulement.",
])
render("charge-locale.png", "Preuve visuelle — charge locale", "Source : preuves/charge-locale.json (mesures brutes du script)", load_lines)

pdf = json.loads((EVIDENCE / "pdf-e2e.json").read_text(encoding="utf-8"))
pdf_lines = [
    f"Date : {pdf['date']}    Cible : {pdf['target']}",
    "",
    f"Réservation HTTP : {pdf['reservation_status']}    Statut consulté : HTTP {pdf['status_poll_http']}",
    f"État final : {pdf['final_state']}    Révision du document : {pdf['revision']}",
    f"Téléchargement HTTP : {pdf['download_status']}    Signature PDF : {pdf['pdf_signature']}",
    f"Taille : {pdf['file_bytes']} octets    Durée de traitement et interrogation : {pdf['processing_and_polling_ms']} ms",
    f"Utilisations du quota consommées : {pdf['quota_uses_consumed']}",
]
render("pdf-e2e.png", "Preuve visuelle — téléchargement PDF", "Source : preuves/pdf-e2e.json (parcours visiteur de bout en bout)", pdf_lines)

print("Captures monochromes créées :")
for path in sorted(CAPTURES.glob("*.png")):
    print(f"- {path.relative_to(ROOT)}")
