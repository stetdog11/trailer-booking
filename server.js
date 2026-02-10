const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const cors = require("cors");
const basicAuth = require("express-basic-auth");

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Database
const db = new sqlite3.Database("./bookings.db");

// Create table if it doesn't exist
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

// Time slots (fixed)
const slots = {
  1: "9:00 AM - 12:00 PM",
  2: "12:00 PM - 3:00 PM",
  3: "3:00 PM - 6:00 PM",
};
// ===== Admin lock (Basic Auth) =====
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "change-me";

const adminAuth = basicAuth({
  users: { [ADMIN_USER]: ADMIN_PASS },
  challenge: true,
});

// Protect admin HTML + admin API
app.use("/admin.html", adminAuth);
app.use("/admin/bookings", adminAuth);

// Get availability for a date
app.get("/availability", (req, res) => {
  const { date } = req.query;

  db.all(
    "SELECT slot FROM bookings WHERE date = ? AND status = 'booked'",
    [date],
    (err, rows) => {
      if (err) return res.status(500).json(err);

      const bookedSlots = rows.map((r) => r.slot);
      const availability = Object.keys(slots).map((slot) => ({
        slot: Number(slot),
        label: slots[slot],
        available: !bookedSlots.includes(Number(slot)),
      }));

      res.json(availability);
    },
  );
});

// Book a slot
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
      res.json({ success: true });
    },
  );
});

// Admin view
app.get("/admin/bookings", (req, res) => {
  const { date } = req.query;

  db.all(
    "SELECT * FROM bookings WHERE date = ? ORDER BY slot",
    [date],
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    },
  );
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
