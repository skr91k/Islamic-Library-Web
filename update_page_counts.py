#!/usr/bin/env python3
"""
Script to update page_count in master.sqlite from individual book sqlite.zip files.
"""

import sqlite3
import zipfile
import os
from pathlib import Path

# ============================================================
# CONFIGURE THESE PATHS
# ============================================================

# Folder containing book sqlite.zip files (e.g., "1-5-0.sqlite.zip")
SQLITE_ZIP_FOLDER = "/Users/shakir/Desktop/books/new mac zip"


# Path to master.sqlite file
MASTER_SQLITE_PATH = "/Users/shakir/Islamic-Library-Web/public/master.sqlite"

# ============================================================


def get_page_count_from_zip(zip_path: str) -> int:
    """Extract sqlite from zip in memory and count rows in page table."""
    try:
        with zipfile.ZipFile(zip_path, 'r') as zf:
            # Find the sqlite file inside the zip
            sqlite_files = [f for f in zf.namelist() if f.endswith('.sqlite') or f.endswith('.db')]
            if not sqlite_files:
                print(f"  Warning: No sqlite file found in {zip_path}")
                return 0

            sqlite_filename = sqlite_files[0]

            # Extract to memory
            sqlite_data = zf.read(sqlite_filename)

            # Write to temporary in-memory file and open with sqlite3
            # sqlite3 needs a file path, so we use a temp file approach
            import tempfile
            with tempfile.NamedTemporaryFile(delete=False, suffix='.sqlite') as tmp:
                tmp.write(sqlite_data)
                tmp_path = tmp.name

            try:
                conn = sqlite3.connect(tmp_path)
                cursor = conn.cursor()
                cursor.execute("SELECT COUNT(*) FROM page")
                count = cursor.fetchone()[0]
                conn.close()
                return count
            finally:
                os.unlink(tmp_path)

    except zipfile.BadZipFile:
        print(f"  Error: Bad zip file {zip_path}")
        return 0
    except sqlite3.Error as e:
        print(f"  Error reading sqlite from {zip_path}: {e}")
        return 0
    except Exception as e:
        print(f"  Unexpected error with {zip_path}: {e}")
        return 0


def main():
    sqlite_zip_folder = Path(SQLITE_ZIP_FOLDER)
    master_sqlite_path = Path(MASTER_SQLITE_PATH)

    print(f"SQLite zip folder: {sqlite_zip_folder}")
    print(f"Master sqlite: {master_sqlite_path}")

    if not sqlite_zip_folder.exists():
        print(f"Error: Folder not found: {sqlite_zip_folder}")
        return

    if not master_sqlite_path.exists():
        print(f"Error: Master sqlite not found: {master_sqlite_path}")
        return

    # Connect to master database
    conn = sqlite3.connect(master_sqlite_path)
    cursor = conn.cursor()

    # Add page_count column if it doesn't exist
    try:
        cursor.execute("ALTER TABLE book ADD COLUMN page_count INTEGER DEFAULT 0")
        conn.commit()
        print("Added page_count column to book table")
    except sqlite3.OperationalError:
        print("page_count column already exists")

    # Get all books from master
    cursor.execute("SELECT book_id, major_online, minor_online, book_name FROM book")
    books = cursor.fetchall()

    print(f"\nProcessing {len(books)} books...")

    updated = 0
    not_found = 0
    errors = 0

    for i, (book_id, major_online, minor_online, book_name) in enumerate(books):
        # Construct filename: book_id-major_online-minor_online.sqlite.zip
        filename = f"{book_id}-{major_online}-{minor_online}.sqlite.zip"
        zip_path = sqlite_zip_folder / filename

        if not zip_path.exists():
            not_found += 1
            continue

        page_count = get_page_count_from_zip(str(zip_path))

        if page_count > 0:
            cursor.execute("UPDATE book SET page_count = ? WHERE book_id = ?", (page_count, book_id))
            updated += 1
            if updated % 100 == 0:
                conn.commit()
                print(f"  Progress: {updated} books updated...")
        else:
            errors += 1

        # Progress indicator
        if (i + 1) % 500 == 0:
            print(f"  Processed {i + 1}/{len(books)} books...")

    conn.commit()

    # Compact database to remove unused space
    print("\nVacuuming database to reclaim space...")
    cursor.execute("VACUUM")

    conn.close()

    print(f"\nDone!")
    print(f"  Updated: {updated} books")
    print(f"  Not found: {not_found} zip files")
    print(f"  Errors: {errors} books")


if __name__ == "__main__":
    main()
