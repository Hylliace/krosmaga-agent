#!/usr/bin/env python3
"""Read a krosmaga.tools deck and keep only the id and count of each card.

The site is a single-page app: the decklist is not in the HTML, it comes from a
client call to a public API:

    get https://psalles.ovh:8443/api/public/decks/{uuid}/language/{lang}/version/{version}

Needs requests  ->  pip install requests

Examples:
    python extractor.py "https://krosmaga.tools/decks/view/6cd4ae9c-c7e6-469d-bbd6-e8ab76835cda/1/1"
    python extractor.py <url> --out deck.json
    python extractor.py 6cd4ae9c-c7e6-469d-bbd6-e8ab76835cda
"""
import argparse
import json
import re
import sys

import requests

API = "https://psalles.ovh:8443/api/public/decks/{uuid}/language/{lang}/version/{version}"
UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


def parse_ref(ref):
    """Return (uuid, version) from a full URL or a bare UUID.

    URL format on the site: /decks/view/{uuid}/{version}/{minor}.
    The first integer after the UUID is taken as the version (default 1).
    """
    m = UUID_RE.search(ref)
    if not m:
        raise ValueError("Aucun UUID de deck trouve dans : %r" % ref)
    version = 1
    vm = re.search(r"/(\d+)", ref[m.end():])
    if vm:
        version = int(vm.group(1))
    return m.group(0), version


def fetch_deck(uuid, lang="FR", version=1, timeout=20, verify=True):
    url = API.format(uuid=uuid, lang=lang, version=version)
    resp = requests.get(url, timeout=timeout, verify=verify)
    resp.raise_for_status()
    return resp.json()


def extract(deck):
    """List of (id, count) for each card of the deck."""
    return [(c.get("id"), c.get("count")) for c in deck.get("cards", [])]


def main():
    ap = argparse.ArgumentParser(
        description="Recupere l'id et le nombre de chaque carte d'un deck krosmaga.tools."
    )
    ap.add_argument("ref", help="URL du deck ou UUID")
    ap.add_argument("--lang", default="FR", help="Langue : FR, EN, ES, BR, RU (defaut FR)")
    ap.add_argument("--version", type=int, default=None, help="Force la version (sinon lue dans l'URL)")
    ap.add_argument("--out", default=None, help="Ecrit le resultat JSON dans ce fichier")
    ap.add_argument("--no-verify", action="store_true", help="Desactive la verif SSL (si erreur de certificat)")
    args = ap.parse_args()

    try:
        uuid, version = parse_ref(args.ref)
    except ValueError as e:
        print(e, file=sys.stderr)
        sys.exit(1)
    if args.version is not None:
        version = args.version

    try:
        deck = fetch_deck(uuid, args.lang, version, verify=not args.no_verify)
    except requests.exceptions.SSLError:
        print("Erreur SSL. Relance avec --no-verify si tu fais confiance a l'hote.", file=sys.stderr)
        sys.exit(2)
    except requests.exceptions.RequestException as e:
        print("Erreur reseau/HTTP : %s" % e, file=sys.stderr)
        sys.exit(2)

    cards = extract(deck)

    # stdout : uniquement "id count", une carte par ligne
    for card_id, count in cards:
        print("%s %s" % (card_id, count))

    if args.out:
        payload = [{"id": cid, "count": cnt} for cid, cnt in cards]
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print("JSON ecrit dans %s" % args.out, file=sys.stderr)


if __name__ == "__main__":
    main()