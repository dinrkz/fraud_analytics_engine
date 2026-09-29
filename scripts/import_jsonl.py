"""Stream a JSON Lines file to FastAPI in bounded, retry-safe batches."""
import argparse
import json
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file",type=Path)
    parser.add_argument("--url",default="http://localhost:8088/engine/ingest")
    parser.add_argument("--batch-size",type=int,default=100)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 500:
        parser.error("batch-size must be between 1 and 500")
    totals = {"accepted":0,"duplicates":0,"alerts":0}

    def submit(batch):
        body = json.dumps(batch).encode()
        for attempt in range(5):
            try:
                with urlopen(Request(args.url,data=body,headers={"Content-Type":"application/json"}),timeout=30) as response:
                    result = json.load(response)
                for key in totals:
                    totals[key] += result[key]
                return
            except HTTPError as exc:
                if exc.code < 500 or attempt == 4:
                    raise
            except (URLError,TimeoutError):
                if attempt == 4:
                    raise
            time.sleep(min(8,2**attempt))

    batch = []
    with args.file.open(encoding="utf-8-sig") as source:
        for number,line in enumerate(source,1):
            if not line.strip():
                continue
            try:
                batch.append(json.loads(line))
            except ValueError as exc:
                raise SystemExit(f"Invalid JSON at line {number}: {exc}") from exc
            if len(batch) >= args.batch_size:
                submit(batch)
                batch = []
        if batch:
            submit(batch)
    print(json.dumps(totals))


if __name__ == "__main__":
    main()
