const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'mindedge-secret-change-in-production';
const DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());
app.use(cookieParser());

// ── AUTH MIDDLEWARE ──────────────────────────────────────────────
function requireAccess(req, res, next) {
  const token = req.cookies.mindedge_access;
  if (!token) return res.redirect('/paywall');
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('mindedge_access');
    res.redirect('/paywall');
  }
}

// ── STATIC ASSETS ────────────────────────────────────────────────
app.use('/paywall-assets', express.static(path.join(__dirname, 'paywall')));

// ── ROUTES ───────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const token = req.cookies.mindedge_access;
  if (token) {
    try { jwt.verify(token, JWT_SECRET); return res.redirect('/app'); } catch {}
  }
  res.redirect('/paywall');
});

app.get('/paywall', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'paywall', 'index.html'));
});

app.get('/app', requireAccess, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0' });
});

// ── STRIPE CHECKOUT ──────────────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'MindEdge — Lifetime Access',
            description: 'AI-powered trading psychology platform. One-time payment, lifetime access.',
          },
          unit_amount: 1499,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${DOMAIN}/paywall`,
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PAYMENT VERIFICATION ─────────────────────────────────────────
app.get('/payment-success', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.redirect('/paywall');
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') return res.redirect('/paywall');

    const token = jwt.sign(
      { access: true, email: session.customer_details?.email || 'user', paid_at: Date.now() },
      JWT_SECRET,
      { expiresIn: '3650d' }
    );

    res.cookie('mindedge_access', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 3650,
    });

    res.redirect('/app');
  } catch (err) {
    console.error('Verification error:', err);
    res.redirect('/paywall?error=verification_failed');
  }
});

// ── CLAUDE PROXY (protected) ─────────────────────────────────────
app.post('/api/chat', requireAccess, async (req, res) => {
  const { messages, system } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: system || '',
        messages,
      }),
    });
    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'API error' });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Failed to reach Anthropic API' });
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('mindedge_access');
  res.redirect('/paywall');
});

app.listen(PORT, () => {
  console.log(`MindEdge server running on port ${PORT}`);
});
