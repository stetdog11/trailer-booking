// server.js
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const cors = require("cors");
const basicAuth = require("express-basic-auth");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Middleware =====
app.use(cors());
app.use(express.json());

// ===== Env =====
const ADMIN_USER = process.env.ADMIN_USER || "allkeys";
const ADMIN_PASS = process.env.ADMIN_PASS || "seadog";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "";
const OWNER_NOTIFY_EMAIL = process.env.OWNER_NOTIFY_EMAIL || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

// ===== Basic Auth =====
const adminAuth = basicAuth({
  users: { [ADMIN_USER]: ADMIN_PASS },
  challenge: true,
});

// ===== Database =====
const db = new sqlite3.Database("./bookings.db");

// status: booked | canceled | completed
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

const slots = {
  1: "9:00 AM - 12:00 PM",
  2: "12:00 PM - 3:00 PM",
  3: "3:00 PM - 6:00 PM",
};

function slotLabel(slot) {
  return slots[String(slot)] || `Slot ${slot}`;
}

function esc(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function absUrl(p) {
  const base = (PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (!base) return p;
  return base + p;
}

// ===== Resend (email -> SMS) =====
// NOTE: Node 18+ has fetch built in. If your runtime is older, upgrade node on Render.
async function resendSend({ to, subject, text, html }) {
  if (!RESEND_API_KEY || !FROM_EMAIL || !to) return;

  if (typeof fetch !== "function") {
    console.log("Missing fetch(). Use Node 18+ runtime on Render.");
    return;
  }

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: Array.isArray(to) ? to : [to],
        subject,
        ...(html ? { html } : {}),
        ...(text ? { text } : {}),
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.log("Resend error:", resp.status, body);
    }
  } catch (e) {
    console.log("Resend exception:", e.message || e);
  }
}

async function notifyOwnerNewBooking(booking) {
  if (!OWNER_NOTIFY_EMAIL) return;

  const subject = `NEW BOOKING: ${booking.date} ${booking.slotLabel}`;
  const text = `NEW BOOKING
Date: ${booking.date}
Time: ${booking.slotLabel}
Name: ${booking.name || "-"}
Phone: ${booking.phone || "-"}
Email: ${booking.email || "-"}
Address: ${booking.address || "-"}
Notes: ${booking.notes || "-"}

Admin: ${absUrl("/admin")}
`;

  await resendSend({
    to: OWNER_NOTIFY_EMAIL,
    subject,
    text,
  });
}

// ===== Debug ping =====
app.get("/__ping", (req, res) => {
  res.type("text").send("PING-OK");
});

// ===== Admin routes (PROTECTED) =====
// /admin should open the admin page and force auth challenge
app.get("/admin", adminAuth, (req, res) => {
  res.type("html");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Optional: allow /admin.html too, protected
app.get("/admin.html", adminAuth, (req, res) => {
  res.type("html");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Admin API: list bookings
// - if date provided: returns bookings for that date (any status)
// - if no date: returns upcoming booked bookings (today+)
app.get("/admin/bookings", adminAuth, (req, res) => {
  const { date } = req.query;

  if (date) {
    db.all(
      "SELECT * FROM bookings WHERE date = ? ORDER BY date, slot",
      [date],
      (err, rows) => {
        if (err) return res.status(500).json({ error: "DB error" });
        res.json(rows);
      },
    );
    return;
  }

  // Upcoming booked (today and forward)
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(today.getDate()).padStart(2, "0")}`;

  db.all(
    "SELECT * FROM bookings WHERE date >= ? AND status = 'booked' ORDER BY date, slot",
    [ymd],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(rows);
    },
  );
});

// Admin API: cancel booking
app.post("/admin/cancel", adminAuth, (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "Missing id" });

  db.run(
    "UPDATE bookings SET status = 'canceled' WHERE id = ?",
    [id],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json({ success: true });
    },
  );
});

// Admin API: complete booking
app.post("/admin/complete", adminAuth, (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "Missing id" });

  db.run(
    "UPDATE bookings SET status = 'completed' WHERE id = ?",
    [id],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json({ success: true });
    },
  );
});

// ===== Availability =====
app.get("/availability", (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "Missing date" });

  db.all(
    "SELECT slot FROM bookings WHERE date = ? AND status = 'booked'",
    [date],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });

      const booked = rows.map((r) => Number(r.slot));
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
  const { date, slot, name, phone, email, address, notes } = req.body || {};
  if (!date || !slot)
    return res.status(400).json({ error: "Missing date/slot" });

  db.run(
    `
    INSERT INTO bookings (date, slot, name, phone, email, address, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [date, slot, name, phone, email, address, notes],
    function (err) {
      if (err) return res.status(400).json({ error: "Slot already booked" });

      const bookingId = this.lastID;

      // Respond immediately (fast UX)
      res.json({ success: true, id: bookingId });

      // Fire-and-forget owner notify (email->sms)
      notifyOwnerNewBooking({
        id: bookingId,
        date,
        slot,
        slotLabel: slotLabel(slot),
        name,
        phone,
        email,
        address,
        notes,
      }).catch(() => {});
    },
  );
});

// ===== Static files (LAST) =====
app.use(express.static("public"));

// ===== Start =====
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
