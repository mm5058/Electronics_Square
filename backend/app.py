"""
Electronics Square backend server
=====================================
A small Flask app that:
  - serves the frontend (the files in ../frontend)
  - exposes a JSON API for products, categories, and settings
  - protects admin actions with a real server-side login (Flask session),
    so "who can access the admin panel" is enforced by the server, not
    just hidden in JavaScript.

Run it with:
    pip install -r requirements.txt
    python app.py

Then open http://127.0.0.1:5000 in a browser.
See README.md and USER_GUIDE.md for full details.
"""

import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import Flask, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

try:
    from PIL import Image, ImageOps
    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "..", "frontend")
UPLOAD_DIR = os.path.join(FRONTEND_DIR, "uploads")
DB_PATH = os.path.join(BASE_DIR, "store.db")
BACKUP_DIR = os.path.join(BASE_DIR, "backups")

# ---- Settings for running online (all optional when running on your own computer) ----
#   ES_PRODUCTION=1        online mode: debug off, secure cookies, strict checks below
#   ES_SECRET_KEY=...      long random text that signs login cookies (required online)
#   ES_ADMIN_PASSWORD=...  password for the first admin account (required online)
#   ES_DATA_DIR=/var/data  keep the database, photos and backups here, e.g. on a
#                          Render persistent disk, so they survive restarts and deploys
PRODUCTION = os.environ.get("ES_PRODUCTION") == "1"
DATA_DIR = os.environ.get("ES_DATA_DIR", "").strip()
if DATA_DIR:
    os.makedirs(DATA_DIR, exist_ok=True)
    UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
    DB_PATH = os.path.join(DATA_DIR, "store.db")
    BACKUP_DIR = os.path.join(DATA_DIR, "backups")

# Mauritius time (UTC+4, no daylight saving). Used for sale end dates and backup names.
MU_TZ = timezone(timedelta(hours=4))

# Debug mode is for working on your own computer. It switches off by itself when
# ES_PRODUCTION=1 is set (see above).
DEBUG_MODE = not PRODUCTION

os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")

# Largest upload accepted (a restored backup can contain many photos).
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024

# Session cookie signing key. A fixed dev key is fine for local/LAN use;
# change it (or set the ES_SECRET_KEY environment variable) before putting
# this anywhere more exposed than your own network.
app.secret_key = os.environ.get("ES_SECRET_KEY", "electronics-square-dev-key-change-me")

if PRODUCTION:
    if app.secret_key == "electronics-square-dev-key-change-me" or len(app.secret_key) < 24:
        raise RuntimeError("Online mode needs ES_SECRET_KEY set to a long random text (24+ characters).")
    # Behind Render's HTTPS proxy: trust its headers (real visitor address, https links),
    # and only send the login cookie over HTTPS.
    from werkzeug.middleware.proxy_fix import ProxyFix

    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
    app.config.update(SESSION_COOKIE_SECURE=True, SESSION_COOKIE_SAMESITE="Lax")

# Simple in-memory brute-force guard for login attempts (per process).
_login_attempts = {}  # ip -> (count, first_attempt_timestamp)
MAX_ATTEMPTS = 8
WINDOW_SECONDS = 300

# Settings that always exist, even on a database created before they were
# introduced. Values saved in the settings table override these.
DEFAULT_SETTINGS = {
    "currency_symbol": "Rs",
    "delivery_fee": "275",  # charged when a customer picks delivery instead of store pickup
}


# Database helpers

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS categories (
            slug TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            cat TEXT NOT NULL,
            price INTEGER NOT NULL DEFAULT 0,
            stock INTEGER NOT NULL DEFAULT 0,
            icon TEXT NOT NULL DEFAULT '📦',
            image TEXT,
            desc TEXT DEFAULT '',
            badge TEXT,
            details TEXT DEFAULT '',
            specs TEXT DEFAULT '',
            sale_price INTEGER,
            sale_ends TEXT,
            FOREIGN KEY (cat) REFERENCES categories(slug)
        );

        -- All photos of a product (the one with the lowest position is the
        -- "main" photo). products.image always mirrors that main photo so
        -- the product cards keep working.
        CREATE TABLE IF NOT EXISTS product_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        );

        -- Customer orders placed from the cart. Prices are copied in at the
        -- moment of ordering, so later price changes never alter old orders.
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            number TEXT,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'new',
            customer_name TEXT NOT NULL,
            customer_phone TEXT NOT NULL,
            fulfilment TEXT NOT NULL DEFAULT 'pickup',
            address TEXT DEFAULT '',
            subtotal INTEGER NOT NULL DEFAULT 0,
            delivery_fee INTEGER NOT NULL DEFAULT 0,
            total INTEGER NOT NULL DEFAULT 0,
            stock_deducted INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            product_id TEXT NOT NULL,
            name TEXT NOT NULL,
            price INTEGER NOT NULL,
            qty INTEGER NOT NULL,
            FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        );

        -- Messages sent through the contact form on the website.
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            phone TEXT DEFAULT '',
            message TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'new'
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS admin_users (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL
        );
        """
    )

    # --- Upgrade older databases in place (safe to run on every start) ---
    existing_cols = {r["name"] for r in db.execute("PRAGMA table_info(products)").fetchall()}
    for col, col_type in (
        ("details", "TEXT DEFAULT ''"),
        ("specs", "TEXT DEFAULT ''"),
        ("sale_price", "INTEGER"),
        ("sale_ends", "TEXT"),
    ):
        if col not in existing_cols:
            db.execute(f"ALTER TABLE products ADD COLUMN {col} {col_type}")
    # Older versions kept one photo in products.image. Copy it into the
    # gallery table so it shows up as the product's main photo.
    for row in db.execute("SELECT id, image FROM products WHERE image IS NOT NULL AND image != ''").fetchall():
        has_gallery = db.execute("SELECT 1 FROM product_images WHERE product_id = ?", (row["id"],)).fetchone()
        if not has_gallery:
            db.execute(
                "INSERT INTO product_images (product_id, filename, position) VALUES (?, ?, 0)",
                (row["id"], row["image"]),
            )

    # Seed data only if the database is empty (first run).
    existing = db.execute("SELECT COUNT(*) AS n FROM categories").fetchone()["n"]
    if existing == 0:
        categories = [
            ("drones", "Drones"),
            ("gaming", "Gaming"),
            ("audio", "Audio"),
            ("smart-home", "Smart Home"),
        ]
        db.executemany("INSERT INTO categories (slug, name) VALUES (?, ?)", categories)

        products = [
            ("d1", "k12 Max", "drones", 4750, 6, "🛸", None, "1080p camera, 15-min flight time, beginner-friendly controls.", "Best Seller"),
        ]
        db.executemany(
            "INSERT INTO products (id, name, cat, price, stock, icon, image, desc, badge) VALUES (?,?,?,?,?,?,?,?,?)",
            products,
        )

        db.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)", ("whatsapp_number", "23000000000")
        )
        db.execute("INSERT INTO settings (key, value) VALUES (?, ?)", ("currency_symbol", "Rs"))

    # Always make sure a default admin account exists so the panel is
    # reachable on first run. CHANGE THIS PASSWORD see USER_GUIDE.md.
    admin_exists = db.execute("SELECT COUNT(*) AS n FROM admin_users").fetchone()["n"]
    if admin_exists == 0:
        first_password = os.environ.get("ES_ADMIN_PASSWORD") or (None if PRODUCTION else "changeme123")
        if not first_password:
            raise RuntimeError("Online mode needs ES_ADMIN_PASSWORD set (the password for the first admin account).")
        db.execute(
            "INSERT INTO admin_users (username, password_hash) VALUES (?, ?)",
            ("admin", generate_password_hash(first_password)),
        )

    # Make sure newer settings exist on databases created by older versions.
    db.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
        ("delivery_fee", DEFAULT_SETTINGS["delivery_fee"]),
    )

    db.commit()
    db.close()


# Auth

def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("logged_in"):
            return jsonify({"error": "Not authenticated"}), 401
        return view(*args, **kwargs)

    return wrapped


def slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "item"


# Auth routes

@app.route("/api/login", methods=["POST"])
def login():
    ip = request.remote_addr or "unknown"
    count, first_seen = _login_attempts.get(ip, (0, time.time()))
    if time.time() - first_seen > WINDOW_SECONDS:
        count, first_seen = 0, time.time()
    if count >= MAX_ATTEMPTS:
        return jsonify({"error": "Too many attempts. Try again in a few minutes."}), 429

    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    db = get_db()
    row = db.execute(
        "SELECT * FROM admin_users WHERE username = ?", (username,)
    ).fetchone()

    if row and check_password_hash(row["password_hash"], password):
        session.clear()
        session["logged_in"] = True
        session["username"] = username
        session.permanent = True
        _login_attempts.pop(ip, None)
        return jsonify({"ok": True, "username": username})

    _login_attempts[ip] = (count + 1, first_seen)
    return jsonify({"error": "Incorrect username or password"}), 401


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/session", methods=["GET"])
def session_status():
    return jsonify({"logged_in": bool(session.get("logged_in")), "username": session.get("username")})


@app.route("/api/change-password", methods=["POST"])
@login_required
def change_password():
    data = request.get_json(silent=True) or {}
    current = data.get("current_password") or ""
    new = data.get("new_password") or ""
    if len(new) < 6:
        return jsonify({"error": "New password must be at least 6 characters."}), 400

    db = get_db()
    row = db.execute(
        "SELECT * FROM admin_users WHERE username = ?", (session["username"],)
    ).fetchone()
    if not row or not check_password_hash(row["password_hash"], current):
        return jsonify({"error": "Current password is incorrect."}), 401

    db.execute(
        "UPDATE admin_users SET password_hash = ? WHERE username = ?",
        (generate_password_hash(new), session["username"]),
    )
    db.commit()
    return jsonify({"ok": True})


# Category routes

@app.route("/api/categories", methods=["GET"])
def list_categories():
    db = get_db()
    rows = db.execute("SELECT slug, name FROM categories ORDER BY name").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/categories", methods=["POST"])
@login_required
def add_category():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Category name is required."}), 400

    slug = slugify(name)
    db = get_db()
    existing = db.execute("SELECT 1 FROM categories WHERE slug = ?", (slug,)).fetchone()
    if existing:
        return jsonify({"error": "That category already exists."}), 400

    db.execute("INSERT INTO categories (slug, name) VALUES (?, ?)", (slug, name))
    db.commit()
    return jsonify({"slug": slug, "name": name}), 201


@app.route("/api/categories/<slug>", methods=["DELETE"])
@login_required
def delete_category(slug):
    db = get_db()
    in_use = db.execute("SELECT COUNT(*) AS n FROM products WHERE cat = ?", (slug,)).fetchone()["n"]
    if in_use > 0:
        return jsonify({"error": f"{in_use} product(s) still use this category. Move or delete them first."}), 400

    db.execute("DELETE FROM categories WHERE slug = ?", (slug,))
    db.commit()
    return jsonify({"ok": True})


# Product routes

def mu_today():
    return datetime.now(MU_TZ).date()


def sale_is_active(row):
    """True if the product has a valid sale price that hasn't ended yet.
    A sale price that is not lower than the regular price is ignored."""
    sale = row["sale_price"]
    if sale is None or not (0 <= sale < row["price"]):
        return False
    ends = row["sale_ends"]
    if ends and str(ends) < mu_today().isoformat():
        return False  # the sale ran through the end of its last day
    return True


def effective_price(row):
    """The price a customer pays right now."""
    return row["sale_price"] if sale_is_active(row) else row["price"]


def row_to_product(row):
    d = dict(row)
    if d.get("image"):
        d["image"] = f"/uploads/{d['image']}"
    active = sale_is_active(d)
    d["on_sale"] = active
    d["current_price"] = d["sale_price"] if active else d["price"]
    d["discount_percent"] = (
        max(1, round((d["price"] - d["sale_price"]) * 100 / d["price"])) if active and d["price"] else 0
    )
    return d


def attach_images(db, products):
    """Add an 'images' list (every gallery photo, main one first) to each product dict."""
    gallery = {}
    rows = db.execute(
        "SELECT id, product_id, filename FROM product_images ORDER BY position, id"
    ).fetchall()
    for r in rows:
        gallery.setdefault(r["product_id"], []).append(
            {"id": r["id"], "url": f"/uploads/{r['filename']}"}
        )
    for p in products:
        p["images"] = gallery.get(p["id"], [])
    return products


@app.route("/api/products", methods=["GET"])
def list_products():
    db = get_db()
    rows = db.execute("SELECT * FROM products ORDER BY rowid").fetchall()
    return jsonify(attach_images(db, [row_to_product(r) for r in rows]))


@app.route("/api/products/<pid>", methods=["GET"])
def get_product(pid):
    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
    if not row:
        return jsonify({"error": "Product not found."}), 404
    return jsonify(attach_images(db, [row_to_product(row)])[0])


@app.route("/api/products", methods=["POST"])
@login_required
def add_product():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    cat = (data.get("cat") or "").strip()
    if not name or not cat:
        return jsonify({"error": "Name and category are required."}), 400

    db = get_db()
    cat_exists = db.execute("SELECT 1 FROM categories WHERE slug = ?", (cat,)).fetchone()
    if not cat_exists:
        return jsonify({"error": "Unknown category."}), 400

    pid = f"{slugify(name)}-{int(time.time() * 1000) % 100000}"
    db.execute(
        "INSERT INTO products (id, name, cat, price, stock, icon, desc, badge, details, specs) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            pid,
            name,
            cat,
            max(0, int(data.get("price") or 0)),
            max(0, int(data.get("stock") or 0)),
            data.get("icon") or "📦",
            data.get("desc") or "",
            data.get("badge") or None,
            str(data.get("details") or "")[:5000],
            str(data.get("specs") or "")[:5000],
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
    return jsonify(attach_images(db, [row_to_product(row)])[0]), 201


ALLOWED_FIELDS = {"name", "cat", "price", "stock", "icon", "desc", "badge", "details", "specs", "sale_price", "sale_ends"}


@app.route("/api/products/<pid>", methods=["PUT"])
@login_required
def update_product(pid):
    data = request.get_json(silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
    if not row:
        return jsonify({"error": "Product not found."}), 404

    updates = {k: v for k, v in data.items() if k in ALLOWED_FIELDS}
    if "cat" in updates:
        cat_exists = db.execute("SELECT 1 FROM categories WHERE slug = ?", (updates["cat"],)).fetchone()
        if not cat_exists:
            return jsonify({"error": "Unknown category."}), 400
    for long_field in ("details", "specs", "desc"):
        if long_field in updates:
            updates[long_field] = str(updates[long_field] or "")[:5000]
    if "name" in updates:
        updates["name"] = str(updates["name"] or "").strip()[:200]
        if not updates["name"]:
            return jsonify({"error": "Name cannot be empty."}), 400
    if "price" in updates:
        updates["price"] = max(0, int(updates["price"] or 0))
    if "stock" in updates:
        updates["stock"] = max(0, int(updates["stock"] or 0))
    if "sale_price" in updates:
        raw = updates["sale_price"]
        if raw is None or str(raw).strip() == "":
            updates["sale_price"] = None  # no sale
        else:
            try:
                sale = int(float(raw))
            except (TypeError, ValueError):
                return jsonify({"error": "Sale price must be a number."}), 400
            regular = updates.get("price", row["price"])
            if sale < 0 or sale >= regular:
                return jsonify({"error": "The sale price must be lower than the regular price."}), 400
            updates["sale_price"] = sale
    if "sale_ends" in updates:
        raw = updates["sale_ends"]
        if not raw:
            updates["sale_ends"] = None
        else:
            try:
                datetime.strptime(str(raw), "%Y-%m-%d")
            except ValueError:
                return jsonify({"error": "Sale end date must look like 2026-12-31."}), 400
            updates["sale_ends"] = str(raw)

    if updates:
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        db.execute(f"UPDATE products SET {set_clause} WHERE id = ?", (*updates.values(), pid))
        db.commit()

    row = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
    return jsonify(attach_images(db, [row_to_product(row)])[0])


@app.route("/api/products/<pid>", methods=["DELETE"])
@login_required
def delete_product(pid):
    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
    for r in db.execute("SELECT filename FROM product_images WHERE product_id = ?", (pid,)).fetchall():
        _delete_upload_file(r["filename"])
    if row and row["image"]:
        _delete_upload_file(row["image"])
    db.execute("DELETE FROM product_images WHERE product_id = ?", (pid,))
    db.execute("DELETE FROM products WHERE id = ?", (pid,))
    db.commit()
    return jsonify({"ok": True})


# Product photos (a product can have several)

ALLOWED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_IMAGES_PER_PRODUCT = 12


def _delete_upload_file(filename):
    path = os.path.join(UPLOAD_DIR, filename)
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass


def _store_image(file, pid):
    """Validate, shrink and save one uploaded photo. Returns the stored
    filename, or None if the file type isn't supported."""
    ext = os.path.splitext(secure_filename(file.filename or ""))[1].lower() or ".jpg"
    if ext not in ALLOWED_IMAGE_EXTS:
        return None

    filename = f"{pid}-{uuid.uuid4().hex[:10]}{ext}"
    save_path = os.path.join(UPLOAD_DIR, filename)

    if HAS_PILLOW:
        try:
            img = Image.open(file.stream)
            img = ImageOps.exif_transpose(img)  # fix sideways phone photos
            if ext in {".jpg", ".jpeg"}:
                img = img.convert("RGB")
            img.thumbnail((1400, 1400))
            img.save(save_path, quality=85, optimize=True)
        except Exception:
            file.stream.seek(0)
            file.save(save_path)
    else:
        file.save(save_path)
    return filename


def _sync_cover(db, pid):
    """Keep products.image pointing at the product's main (first) photo."""
    first = db.execute(
        "SELECT filename FROM product_images WHERE product_id = ? ORDER BY position, id LIMIT 1",
        (pid,),
    ).fetchone()
    db.execute("UPDATE products SET image = ? WHERE id = ?", (first["filename"] if first else None, pid))


@app.route("/api/products/<pid>/images", methods=["POST"])
@login_required
def upload_product_images(pid):
    db = get_db()
    row = db.execute("SELECT id FROM products WHERE id = ?", (pid,)).fetchone()
    if not row:
        return jsonify({"error": "Product not found."}), 404

    files = [f for f in request.files.getlist("images") if f and f.filename]
    if not files:
        return jsonify({"error": "No files uploaded."}), 400

    current = db.execute("SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?", (pid,)).fetchone()["n"]
    if current + len(files) > MAX_IMAGES_PER_PRODUCT:
        return jsonify({"error": f"A product can have at most {MAX_IMAGES_PER_PRODUCT} photos."}), 400

    position = db.execute(
        "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM product_images WHERE product_id = ?", (pid,)
    ).fetchone()["p"]

    saved = 0
    for f in files:
        filename = _store_image(f, pid)
        if filename is None:
            continue
        db.execute(
            "INSERT INTO product_images (product_id, filename, position) VALUES (?, ?, ?)",
            (pid, filename, position),
        )
        position += 1
        saved += 1

    if saved == 0:
        return jsonify({"error": "Unsupported image type. Use JPG, PNG, WEBP or GIF."}), 400

    _sync_cover(db, pid)
    db.commit()
    product = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
    return jsonify(attach_images(db, [row_to_product(product)])[0]), 201


@app.route("/api/products/<pid>/images/<int:image_id>", methods=["DELETE"])
@login_required
def delete_product_image(pid, image_id):
    db = get_db()
    img = db.execute(
        "SELECT * FROM product_images WHERE id = ? AND product_id = ?", (image_id, pid)
    ).fetchone()
    if not img:
        return jsonify({"error": "Photo not found."}), 404
    _delete_upload_file(img["filename"])
    db.execute("DELETE FROM product_images WHERE id = ?", (image_id,))
    _sync_cover(db, pid)
    db.commit()
    product = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
    return jsonify(attach_images(db, [row_to_product(product)])[0])


@app.route("/api/products/<pid>/images/<int:image_id>/main", methods=["PUT"])
@login_required
def make_main_image(pid, image_id):
    db = get_db()
    img = db.execute(
        "SELECT * FROM product_images WHERE id = ? AND product_id = ?", (image_id, pid)
    ).fetchone()
    if not img:
        return jsonify({"error": "Photo not found."}), 404
    lowest = db.execute(
        "SELECT MIN(position) AS p FROM product_images WHERE product_id = ?", (pid,)
    ).fetchone()["p"]
    db.execute("UPDATE product_images SET position = ? WHERE id = ?", (lowest - 1, image_id))
    _sync_cover(db, pid)
    db.commit()
    product = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
    return jsonify(attach_images(db, [row_to_product(product)])[0])


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename)



# Settings

@app.route("/api/settings", methods=["GET"])
def get_settings():
    db = get_db()
    rows = db.execute("SELECT key, value FROM settings").fetchall()
    settings = dict(DEFAULT_SETTINGS)
    settings.update({r["key"]: r["value"] for r in rows})
    return jsonify(settings)


@app.route("/api/settings", methods=["PUT"])
@login_required
def update_settings():
    data = request.get_json(silent=True) or {}
    db = get_db()
    if "delivery_fee" in data:
        try:
            data["delivery_fee"] = str(max(0, int(float(data["delivery_fee"]))))
        except (TypeError, ValueError):
            return jsonify({"error": "Delivery fee must be a number."}), 400
    for key in ("whatsapp_number", "currency_symbol", "delivery_fee"):
        if key in data:
            db.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, str(data[key])),
            )
    db.commit()
    return jsonify({"ok": True})



# Backup / export

@app.route("/api/export", methods=["GET"])
@login_required
def export_data():
    db = get_db()
    categories = [dict(r) for r in db.execute("SELECT * FROM categories").fetchall()]
    products = attach_images(db, [row_to_product(r) for r in db.execute("SELECT * FROM products").fetchall()])
    settings = {r["key"]: r["value"] for r in db.execute("SELECT * FROM settings").fetchall()}
    return jsonify({"categories": categories, "products": products, "settings": settings})



# ---------------------------------------------------------------------
# Small helpers: client address and a soft rate limit for public forms
# ---------------------------------------------------------------------
_rate_hits = {}  # key -> list of timestamps


def _client_ip():
    forwarded = request.headers.get("X-Forwarded-For", "")
    return forwarded.split(",")[0].strip() or request.remote_addr or "unknown"


def _rate_limited(key, limit, window_seconds):
    """True if `key` has already done `limit` things in the last window."""
    now = time.time()
    hits = [t for t in _rate_hits.get(key, []) if now - t < window_seconds]
    if len(hits) >= limit:
        _rate_hits[key] = hits
        return True
    hits.append(now)
    _rate_hits[key] = hits
    return False


def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------
# Orders
#   new -> confirmed -> completed, or cancelled at any point.
#   Stock is only taken off when an order is Confirmed (and given back if
#   a confirmed order is cancelled or reopened).
# ---------------------------------------------------------------------
ORDER_STATUSES = ("new", "confirmed", "completed", "cancelled")
STOCK_HOLDING = ("confirmed", "completed")


def _delivery_fee(db):
    row = db.execute("SELECT value FROM settings WHERE key = 'delivery_fee'").fetchone()
    try:
        return max(0, int(float(row["value"] if row else DEFAULT_SETTINGS["delivery_fee"])))
    except (TypeError, ValueError):
        return 275


def load_orders(db, status=None):
    if status:
        rows = db.execute("SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT 300", (status,)).fetchall()
    else:
        rows = db.execute("SELECT * FROM orders ORDER BY id DESC LIMIT 300").fetchall()
    orders = [dict(r) for r in rows]
    if not orders:
        return orders
    marks = ",".join("?" * len(orders))
    items = db.execute(
        f"SELECT * FROM order_items WHERE order_id IN ({marks}) ORDER BY id", [o["id"] for o in orders]
    ).fetchall()
    grouped = {}
    for it in items:
        d = dict(it)
        d["line_total"] = d["price"] * d["qty"]
        grouped.setdefault(d["order_id"], []).append(d)
    for o in orders:
        o["items"] = grouped.get(o["id"], [])
    return orders


@app.route("/api/orders", methods=["POST"])
def create_order():
    """Public: called when a customer presses 'Order via WhatsApp'. Prices
    and the delivery charge are worked out here on the server, never taken
    from the browser."""
    if _rate_limited(f"order:{_client_ip()}", 10, 600):
        return jsonify({"error": "Too many orders from this connection. Please try again in a few minutes."}), 429

    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()[:100]
    phone = re.sub(r"[^\d+ ]", "", str(data.get("phone") or "")).strip()[:30]
    fulfilment = "delivery" if data.get("fulfilment") == "delivery" else "pickup"
    address = str(data.get("address") or "").strip()[:300]

    if len(name) < 2:
        return jsonify({"error": "Please enter your name."}), 400
    if len(re.sub(r"\D", "", phone)) < 7:
        return jsonify({"error": "Please enter a phone number we can reach you on."}), 400

    raw_items = data.get("items")
    if not isinstance(raw_items, list) or not raw_items or len(raw_items) > 50:
        return jsonify({"error": "Your cart is empty."}), 400

    wanted = {}
    for it in raw_items:
        try:
            qty = int(it.get("qty"))
            pid = str(it.get("id"))
        except (AttributeError, TypeError, ValueError):
            return jsonify({"error": "Something is wrong with your cart. Please refresh the page."}), 400
        if qty < 1 or qty > 99:
            return jsonify({"error": "Invalid quantity in your cart."}), 400
        wanted[pid] = wanted.get(pid, 0) + qty

    db = get_db()
    lines = []
    for pid, qty in wanted.items():
        p = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
        if not p:
            return jsonify({"error": "A product in your cart is no longer available. Your cart has been updated.", "refresh": True}), 409
        if p["stock"] <= 0:
            return jsonify({"error": f"Sorry, {p['name']} just sold out.", "refresh": True}), 409
        if qty > p["stock"]:
            return jsonify({"error": f"Only {p['stock']} of {p['name']} left please lower the quantity.", "refresh": True}), 409
        lines.append((p, qty, effective_price(p)))

    subtotal = sum(price * qty for _, qty, price in lines)
    fee = _delivery_fee(db) if fulfilment == "delivery" else 0
    total = subtotal + fee

    cur = db.execute(
        "INSERT INTO orders (created_at, status, customer_name, customer_phone, fulfilment, address, subtotal, delivery_fee, total)"
        " VALUES (?, 'new', ?, ?, ?, ?, ?, ?, ?)",
        (utc_now_iso(), name, phone, fulfilment, address, subtotal, fee, total),
    )
    order_id = cur.lastrowid
    number = f"ES-{order_id:04d}"
    db.execute("UPDATE orders SET number = ? WHERE id = ?", (number, order_id))
    for p, qty, price in lines:
        db.execute(
            "INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)",
            (order_id, p["id"], p["name"], price, qty),
        )
    db.commit()
    return jsonify(load_orders_by_id(db, order_id)), 201


def load_orders_by_id(db, order_id):
    for o in load_orders(db):
        if o["id"] == order_id:
            return o
    row = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    return dict(row) if row else None


@app.route("/api/orders", methods=["GET"])
@login_required
def list_orders():
    status = request.args.get("status")
    return jsonify(load_orders(get_db(), status if status in ORDER_STATUSES else None))


def _apply_order_status(db, order, new_status):
    """Moves an order to `new_status`, taking stock off or giving it back as
    needed. Returns an error message, or None on success."""
    items = db.execute("SELECT * FROM order_items WHERE order_id = ?", (order["id"],)).fetchall()
    deducted = order["stock_deducted"]

    if new_status in STOCK_HOLDING and not deducted:
        problems = []
        for it in items:
            p = db.execute("SELECT name, stock FROM products WHERE id = ?", (it["product_id"],)).fetchone()
            if not p:
                problems.append(f"{it['name']} no longer exists")
            elif p["stock"] < it["qty"]:
                problems.append(f"{p['name']}: only {p['stock']} in stock but the order needs {it['qty']}")
        if problems:
            return "Not enough stock " + "; ".join(problems) + ". Update the stock first, then confirm again."
        for it in items:
            db.execute("UPDATE products SET stock = stock - ? WHERE id = ?", (it["qty"], it["product_id"]))
        deducted = 1
    elif new_status not in STOCK_HOLDING and deducted:
        for it in items:
            db.execute("UPDATE products SET stock = stock + ? WHERE id = ?", (it["qty"], it["product_id"]))
        deducted = 0

    db.execute("UPDATE orders SET status = ?, stock_deducted = ? WHERE id = ?", (new_status, deducted, order["id"]))
    return None


@app.route("/api/orders/<int:order_id>/status", methods=["PUT"])
@login_required
def set_order_status(order_id):
    data = request.get_json(silent=True) or {}
    new_status = data.get("status")
    if new_status not in ORDER_STATUSES:
        return jsonify({"error": "Unknown status."}), 400
    db = get_db()
    order = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        return jsonify({"error": "Order not found."}), 404
    error = _apply_order_status(db, order, new_status)
    if error:
        db.rollback()
        return jsonify({"error": error}), 409
    db.commit()
    return jsonify(load_orders_by_id(db, order_id))


@app.route("/api/orders/<int:order_id>", methods=["DELETE"])
@login_required
def delete_order(order_id):
    db = get_db()
    order = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        return jsonify({"error": "Order not found."}), 404
    if order["status"] != "cancelled":
        return jsonify({"error": "Only cancelled orders can be deleted. Cancel it first."}), 400
    db.execute("DELETE FROM order_items WHERE order_id = ?", (order_id,))
    db.execute("DELETE FROM orders WHERE id = ?", (order_id,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------
# Contact form messages
# ---------------------------------------------------------------------
@app.route("/api/messages", methods=["POST"])
def create_message():
    data = request.get_json(silent=True) or {}

    # Hidden "website" field: real visitors never see or fill it, bots do.
    # Pretend it worked so the bot doesn't learn anything.
    if str(data.get("website") or "").strip():
        return jsonify({"ok": True}), 201

    if _rate_limited(f"message:{_client_ip()}", 5, 600):
        return jsonify({"error": "You've sent a few messages already. Please try again in a few minutes."}), 429

    name = str(data.get("name") or "").strip()[:100]
    email = str(data.get("email") or "").strip()[:200]
    phone = re.sub(r"[^\d+ ]", "", str(data.get("phone") or "")).strip()[:30]
    message = str(data.get("message") or "").strip()[:3000]

    if not name:
        return jsonify({"error": "Please enter your name."}), 400
    if "@" not in email or "." not in email.split("@")[-1]:
        return jsonify({"error": "Please enter a valid email address."}), 400
    if len(message) < 3:
        return jsonify({"error": "Please write a message."}), 400

    db = get_db()
    db.execute(
        "INSERT INTO messages (created_at, name, email, phone, message, status) VALUES (?, ?, ?, ?, ?, 'new')",
        (utc_now_iso(), name, email, phone, message),
    )
    db.commit()
    return jsonify({"ok": True}), 201


@app.route("/api/messages", methods=["GET"])
@login_required
def list_messages():
    rows = get_db().execute("SELECT * FROM messages ORDER BY id DESC LIMIT 300").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/messages/<int:message_id>", methods=["PUT"])
@login_required
def update_message(message_id):
    status = (request.get_json(silent=True) or {}).get("status")
    if status not in ("new", "read"):
        return jsonify({"error": "Unknown status."}), 400
    db = get_db()
    db.execute("UPDATE messages SET status = ? WHERE id = ?", (status, message_id))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/messages/<int:message_id>", methods=["DELETE"])
@login_required
def delete_message(message_id):
    db = get_db()
    db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------
# Backups
#   A backup is one .zip containing the whole database (store.db) and
#   every product photo (uploads/). A new one is made automatically each
#   day, and you can create, download and restore them from the admin panel.
# ---------------------------------------------------------------------
BACKUP_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$")
BACKUP_KEEP = {"auto": 14, "manual": 10, "pre-restore": 5}  # how many of each kind to keep


class BackupError(Exception):
    """A problem with a backup file that is safe to show to the admin."""


def _prune_backups():
    if not os.path.isdir(BACKUP_DIR):
        return
    for prefix, keep in BACKUP_KEEP.items():
        names = sorted(
            (n for n in os.listdir(BACKUP_DIR) if n.startswith(prefix + "-") and n.endswith(".zip")),
            reverse=True,
        )
        for old in names[keep:]:
            try:
                os.remove(os.path.join(BACKUP_DIR, old))
            except OSError:
                pass


def create_backup(prefix, name=None):
    """Writes a new backup zip into BACKUP_DIR and returns its file name."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    if name is None:
        name = f"{prefix}-{datetime.now(MU_TZ).strftime('%Y%m%d-%H%M%S')}.zip"
    final_path = os.path.join(BACKUP_DIR, name)
    tmp_dir = tempfile.mkdtemp(prefix="esbackup-")
    try:
        snapshot = os.path.join(tmp_dir, "store.db")
        src = sqlite3.connect(DB_PATH)
        dst = sqlite3.connect(snapshot)
        src.backup(dst)  # a consistent copy even while the shop is being used
        dst.close()
        src.close()

        photo_count = 0
        part_path = final_path + ".part"
        with zipfile.ZipFile(part_path, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(snapshot, "store.db")
            for fname in sorted(os.listdir(UPLOAD_DIR)):
                fpath = os.path.join(UPLOAD_DIR, fname)
                if os.path.isfile(fpath) and not fname.startswith("."):
                    z.write(fpath, f"uploads/{fname}")
                    photo_count += 1
            z.writestr(
                "manifest.json",
                json.dumps({"app": "electronics-square", "created": utc_now_iso(), "photos": photo_count}),
            )
        os.replace(part_path, final_path)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    _prune_backups()
    return name


def restore_backup(zip_path):
    """Replaces the shop's data with the contents of a backup zip. A safety
    copy of the current data is saved first. Raises BackupError if the file
    isn't a usable backup."""
    tmp_dir = tempfile.mkdtemp(prefix="esrestore-")
    try:
        try:
            archive = zipfile.ZipFile(zip_path)
        except zipfile.BadZipFile:
            raise BackupError("That file isn't a valid backup (it isn't a zip file).")

        photos = []
        with archive:
            if "store.db" not in archive.namelist():
                raise BackupError("That zip isn't an Electronics Square backup (store.db is missing).")
            if sum(i.file_size for i in archive.infolist()) > 1024 ** 3:
                raise BackupError("That backup is too large to restore.")

            db_tmp = os.path.join(tmp_dir, "store.db")
            with archive.open("store.db") as src, open(db_tmp, "wb") as out:
                shutil.copyfileobj(src, out)

            os.makedirs(os.path.join(tmp_dir, "uploads"), exist_ok=True)
            for info in archive.infolist():
                name = info.filename
                base = os.path.basename(name)
                # Only plain image files directly inside uploads/ are accepted;
                # anything else (folders, odd paths, ../ tricks) is ignored.
                if info.is_dir() or name != f"uploads/{base}" or not base or base.startswith("."):
                    continue
                if os.path.splitext(base)[1].lower() not in ALLOWED_IMAGE_EXTS:
                    continue
                with archive.open(info) as src, open(os.path.join(tmp_dir, "uploads", base), "wb") as out:
                    shutil.copyfileobj(src, out)
                photos.append(base)

        try:
            check = sqlite3.connect(db_tmp)
            integrity = check.execute("PRAGMA integrity_check").fetchone()[0]
            tables = {r[0] for r in check.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            check.close()
        except sqlite3.DatabaseError:
            raise BackupError("The database inside that backup is damaged.")
        if integrity != "ok":
            raise BackupError("The database inside that backup is damaged.")
        if not {"products", "categories", "settings", "admin_users"} <= tables:
            raise BackupError("That database doesn't look like it came from this shop.")

        create_backup("pre-restore")  # safety copy of what is there now

        src = sqlite3.connect(db_tmp)
        dst = sqlite3.connect(DB_PATH)
        src.backup(dst)
        dst.close()
        src.close()

        for fname in os.listdir(UPLOAD_DIR):
            fpath = os.path.join(UPLOAD_DIR, fname)
            if os.path.isfile(fpath):
                os.remove(fpath)
        for base in photos:
            shutil.move(os.path.join(tmp_dir, "uploads", base), os.path.join(UPLOAD_DIR, base))

        init_db()  # brings an older backup up to the current structure
        return {"photos": len(photos)}
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _auto_backup_loop():
    while True:
        try:
            name = f"auto-{datetime.now(MU_TZ).strftime('%Y-%m-%d')}.zip"
            if not os.path.exists(os.path.join(BACKUP_DIR, name)):
                create_backup("auto", name)
        except Exception as exc:  # never let a backup problem stop the shop
            print("Automatic backup failed:", exc)
        time.sleep(3600)


def start_auto_backups():
    threading.Thread(target=_auto_backup_loop, daemon=True).start()


@app.route("/api/backups", methods=["GET"])
@login_required
def list_backups():
    items = []
    if os.path.isdir(BACKUP_DIR):
        for name in os.listdir(BACKUP_DIR):
            path = os.path.join(BACKUP_DIR, name)
            if BACKUP_NAME_RE.match(name) and os.path.isfile(path):
                items.append(
                    {
                        "name": name,
                        "size": os.path.getsize(path),
                        "created": datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "kind": next((k for k in BACKUP_KEEP if name.startswith(k + "-")), "other"),
                    }
                )
    items.sort(key=lambda i: i["created"], reverse=True)
    return jsonify(items)


@app.route("/api/backups", methods=["POST"])
@login_required
def make_backup():
    return jsonify({"name": create_backup("manual")}), 201


@app.route("/api/backups/<name>", methods=["GET"])
@login_required
def download_backup(name):
    if not BACKUP_NAME_RE.match(name) or not os.path.isfile(os.path.join(BACKUP_DIR, name)):
        return jsonify({"error": "Backup not found."}), 404
    return send_from_directory(BACKUP_DIR, name, as_attachment=True)


@app.route("/api/backups/restore", methods=["POST"])
@login_required
def restore_uploaded_backup():
    file = request.files.get("backup")
    if not file or not file.filename:
        return jsonify({"error": "Choose a backup file first."}), 400
    fd, tmp_path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    try:
        file.save(tmp_path)
        result = restore_backup(tmp_path)
    except BackupError as exc:
        return jsonify({"error": str(exc)}), 400
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    return jsonify({"ok": True, **result})


@app.route("/api/backups/<name>/restore", methods=["POST"])
@login_required
def restore_saved_backup(name):
    path = os.path.join(BACKUP_DIR, name)
    if not BACKUP_NAME_RE.match(name) or not os.path.isfile(path):
        return jsonify({"error": "Backup not found."}), 404
    try:
        result = restore_backup(path)
    except BackupError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, **result})


# Frontend serving

@app.route("/")
def serve_index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/product/<pid>")
def serve_product_page(pid):
    """Serves product.html. The title and share-preview tags are filled in
    here on the server so links pasted into WhatsApp/Facebook show the
    product name, price and photo (those apps don't run JavaScript)."""
    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
    with open(os.path.join(FRONTEND_DIR, "product.html"), encoding="utf-8") as f:
        page = f.read()

    if row:
        currency = db.execute("SELECT value FROM settings WHERE key = 'currency_symbol'").fetchone()
        symbol = currency["value"] if currency else "Rs"
        title = f"{row['name']} Electronics Square"
        description = (row["desc"] or f"{row['name']} at Electronics Square.")[:200]
        description = f"{symbol} {effective_price(row):,} · {description}"
        base = request.url_root.rstrip("/")
        image = f"{base}/uploads/{row['image']}" if row["image"] else f"{base}/assets/logo.png"
        status = 200
    else:
        title, description, image, status = "Product not found Electronics Square", "", "", 404

    def esc(text):
        return (text or "").replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")

    page = (
        page.replace("__TITLE__", esc(title))
        .replace("__DESCRIPTION__", esc(description))
        .replace("__OG_IMAGE__", esc(image))
    )
    return page, status, {"Content-Type": "text/html; charset=utf-8"}


@app.route("/<path:path>")
def serve_static(path):
    return send_from_directory(FRONTEND_DIR, path)


if __name__ != "__main__":
    # Started by a production server such as gunicorn (not "python app.py"):
    # prepare the database and daily backups right away.
    init_db()
    start_auto_backups()


if __name__ == "__main__":
    init_db()
    # In debug mode Flask starts two processes; only the real one runs backups.
    if not DEBUG_MODE or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        start_auto_backups()
    print("Electronics Square backend running.")
    print("  Local:   http://127.0.0.1:5000")
    print("  Network: check README.md / USER_GUIDE.md for how other")
    print("           devices on your Wi-Fi can reach this too.")
    # The auto-reloader (debug mode) restarts the server when it sees a changed
    # .py or .zip file. Backups are .zip files, so keep it away from that folder.
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=DEBUG_MODE,
        exclude_patterns=[os.path.join(BACKUP_DIR, "*")],
    )
