"""
Register Usion City in the Usion service registry.

Standalone on purpose: this repo is independent of the Usion monorepo, so the
script talks to MongoDB directly with pymongo instead of importing backend
settings. Point it at the database with an environment variable.

    pip install pymongo
    DATABASE_URL='mongodb+srv://…' python scripts/seed_usion_city.py
    DATABASE_URL='mongodb+srv://…' python scripts/seed_usion_city.py --unpublish

    # optional overrides
    DATABASE_NAME=mongolai
    USION_CITY_WS_URL=wss://<host>/ws
    USION_CITY_IFRAME_URL=https://<host>

⚠️  DATABASE_URL normally points at PRODUCTION. This writes one document
(`services/usion-city`) and upserts the shared `creator-games-studio` user.
Nothing else is touched.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

try:
    from pymongo import MongoClient
except ImportError:  # pragma: no cover - dependency hint
    raise SystemExit("pymongo is required:  pip install pymongo")


SERVICE_ID = "usion-city"
DEFAULT_HOST = "usion-city-production.up.railway.app"

DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("MONGODB_URI")
DATABASE_NAME = os.environ.get("DATABASE_NAME", "mongolai")
WS_URL = os.environ.get("USION_CITY_WS_URL", f"wss://{DEFAULT_HOST}/ws")
IFRAME_URL = os.environ.get("USION_CITY_IFRAME_URL", f"https://{DEFAULT_HOST}")


def now() -> datetime:
    return datetime.now(timezone.utc)


def seed(publish: bool = True) -> None:
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL (or MONGODB_URI) is required")

    client = MongoClient(DATABASE_URL)
    db = client[DATABASE_NAME]

    if not publish:
        db.services.update_one({"id": SERVICE_ID}, {"$set": {"is_published": False}})
        print("✓ Usion City unpublished (hidden from Explore).")
        client.close()
        return

    if not WS_URL.startswith("wss://"):
        raise SystemExit(f"USION_CITY_WS_URL must be wss:// in production (got: {WS_URL})")
    if not IFRAME_URL.startswith("https://"):
        raise SystemExit(f"USION_CITY_IFRAME_URL must be https:// (got: {IFRAME_URL})")

    db.users.update_one(
        {"id": "creator-games-studio"},
        {
            "$set": {
                "phone_number": "90001001",
                "name": "Usion Games",
                "username": "usion_games",
                "is_phone_verified": True,
                "is_active": True,
                "updated_at": now(),
            },
            "$setOnInsert": {
                "created_at": now(),
                "birth_date": datetime(1995, 1, 1, tzinfo=timezone.utc),
                "bio": "We build social multiplayer experiences for Usion.",
            },
        },
        upsert=True,
    )

    service = {
        "id": SERVICE_ID,
        "creator_id": "creator-games-studio",
        "name": "Usion City",
        "description": (
            "A whole city you share with up to 200 players. Run the streets, "
            "steal a car, dodge the spinning bars in the obstacle park — then "
            "the horn sounds and everyone races a checkpoint circuit through "
            "town. Drop in and out any time."
        ),
        "cost": 0,
        "is_published": publish,
        "is_system_default_service": False,
        "created_at": now(),
        # `world` opts into drop-in/drop-out world rooms (joinWorld placement,
        # min_players 1, rooms born "playing").
        "tags": ["game", "multiplayer", "world"],
        "image": "https://images.unsplash.com/photo-1449824913935-59a10b8d2000?auto=format&fit=crop&w=800&q=80",
        "iframe_url": IFRAME_URL,
        "rating": 0,
        "review_count": 0,
        "game_config": {
            "game_type": "iframe",
            "max_players": 200,   # world cap for direct-mode transports
            "min_players": 1,     # worlds never wait for a roster
            "turn_timeout_seconds": 0,
            "min_action_interval_ms": 16,
            "lock_timeout_ms": 1000,
            "initial_state": {},
        },
        # Direct mode: the client connects straight to this repo's world server;
        # the backend issues RS256 game tokens which the server verifies against
        # the platform JWKS. Free game, no paid outcome, so no `signing` block.
        "realtime": {
            "connection_mode": "direct",
            "connection_transport": "websocket",
            "ws_url": WS_URL,
            "protocol_version": "2",
            "heartbeat_interval_ms": 15000,
            "max_payload_bytes": 8192,
            "rate_limits": {"input_per_sec": 60},
        },
        # `metric` is a display hint only; the registry schema accepts
        # "score" or "level" — anything else is rejected when the row is read.
        "leaderboard": {"enabled": True, "metric": "score", "order": "desc"},
    }

    if db.services.find_one({"id": SERVICE_ID}):
        print(f"Updating '{service['name']}'...")
        db.services.update_one({"id": SERVICE_ID}, {"$set": service})
    else:
        print(f"Creating '{service['name']}'...")
        db.services.insert_one(service)

    print(f"✓ Usion City registered! (published={publish})")
    print(f"  client: {IFRAME_URL}")
    print(f"  server: {WS_URL}")
    client.close()


if __name__ == "__main__":
    seed(publish="--unpublish" not in sys.argv)
