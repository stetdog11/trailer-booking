const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const cors = require("cors");
const basicAuth = require("express-basic-auth");
console.log("RUNNING SERVER.JS VERSION 1");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Middleware =====
app.use(cors());
app.use(express.json());

// ===== Database =====
const db = new sqlite3.Database("./bookings.db");

db.run(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    slot INTEGER NOT NULL,
    name TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    notes TEXT,
    status TEXT DEFAULT 'booked',
    UNIQUE(date, slot)
  )
`);

// ===== Slots =====
const slots = {
  1: "9:00 AM - 12:00 PM",
  2: "12:00 PM - 3:00 PM",
  3: "3:00 PM - 6:00 PM",
};

// ===== Admin Auth =====
const ADMIN_USER = process.env.ADMIN_USER || "allkeys";
const ADMIN_PASS = process.env.ADMIN_PASS || "seadog";

const adminAuth = basicAuth({
  users: { [ADMIN_USER]: ADMIN_PASS },
  challenge: true,
});

// ===== Admin Routes (PROTECTED) =====

app.use("/admin.html", adminAuth);
app.use("/admin/bookings", adminAuth);
app.use("/admin/cancel", adminAuth);

// ===== Availability =====
app.get("/availability", (req, res) => {
  const { date } = req.query;

  db.all(
    "SELECT slot FROM bookings WHERE date = ? AND status = 'booked'",
    [date],
    (err, rows) => {
      if (err) return res.status(500).json(err);

      const booked = rows.map((r) => r.slot);
      const availability = Object.keys(slots).map((s) => ({
        slot: Number(s),
        label: slots[s],
        available: !booked.includes(Number(s)),
      }));

      res.json(availability);
    },
  );
});

// ===== Book Slot =====
app.post("/book", (req, res) => {
  const { date, slot, name, phone, email, address, notes } = req.body;

  db.run(
    `
    INSERT INTO bookings (date, slot, name, phone, email, address, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [date, slot, name, phone, email, address, notes],
    function (err) {
      if (err) {
        return res.status(400).json({ error: "Slot already booked" });
      }

      res.json({
        success: true,
        id: this.lastID,
      });
    },
  );
});

// ===== Admin: View Bookings =====
app.get("/admin/bookings", (req, res) => {
  const { date } = req.query;

  const sql = date
    ? "SELECT * FROM bookings WHERE date = ? ORDER BY date, slot"
    : "SELECT * FROM bookings WHERE status = 'booked' ORDER BY date, slot";

  const params = date ? [date] : [];

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});

// ===== Admin: Cancel Booking =====
app.post("/admin/cancel", (req, res) => {
  const { id } = req.body;

  db.run(
    "UPDATE bookings SET status = 'canceled' WHERE id = ?",
    [id],
    function (err) {
      if (err) return res.status(500).json(err);
      res.json({ success: true });
    },
  );
});
app.get("/admin.html", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ===== Static Files (LAST) =====
app.use(express.static("public"));

// ===== Start =====
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
