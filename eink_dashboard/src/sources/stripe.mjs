// Stripe: MRR, aktive Abos und Umsatztrend — je App (app1/app2) + gesamt.
// Reduziert auf das, was das eInk braucht (MRR, aktive Abos, One-time 30d, Umsatztrend).
import Stripe from 'stripe'
import { config } from '../config.mjs'
import { classifyApp } from './usage.mjs'

const emptyByApp = () => ({
  app1: { mrr: 0, subs: 0, oneTime30d: 0 },
  app2: { mrr: 0, subs: 0, oneTime30d: 0 },
  Others: { mrr: 0, subs: 0, oneTime30d: 0 },
})

function monthly(price, qty) {
  if (!price) return 0
  const amount = (price.unit_amount ?? 0) * qty
  const i = price.recurring?.interval
  if (i === 'month') return amount
  if (i === 'year') return Math.round(amount / 12)
  if (i === 'week') return Math.round((amount * 52) / 12)
  return 0
}

export async function getStripe() {
  if (!config.stripeKey) return null
  const stripe = new Stripe(config.stripeKey)

  const now = Math.floor(Date.now() / 1000)
  const d30 = now - 30 * 86400
  const d60 = now - 60 * 86400

  const [activeSubs, invCur, invPrev, sessCur, sessPrev] = await Promise.all([
    stripe.subscriptions.list({ status: 'active', limit: 100, expand: ['data.items.data.price'] }),
    stripe.invoices.list({ created: { gte: d30 }, status: 'paid', limit: 100 }),
    stripe.invoices.list({ created: { gte: d60, lt: d30 }, status: 'paid', limit: 100 }),
    stripe.checkout.sessions.list({ created: { gte: d30 }, status: 'complete', limit: 100, expand: ['data.line_items.data.price'] }),
    stripe.checkout.sessions.list({ created: { gte: d60, lt: d30 }, status: 'complete', limit: 100, expand: ['data.line_items.data.price'] }),
  ])

  const oneTimeCur = sessCur.data.filter(s => s.mode === 'payment' && s.payment_status === 'paid')
  const oneTimePrev = sessPrev.data.filter(s => s.mode === 'payment' && s.payment_status === 'paid')

  // Produktnamen separat laden (für die App-Zuordnung)
  const subPids = activeSubs.data
    .map(s => s.items.data[0]?.price?.product)
    .filter(id => typeof id === 'string' && id.startsWith('prod_'))
  const otPids = []
  for (const s of oneTimeCur) for (const li of s.line_items?.data ?? []) {
    const pid = typeof li.price?.product === 'string' ? li.price.product : null
    if (pid?.startsWith('prod_')) otPids.push(pid)
  }
  const pids = [...new Set([...subPids, ...otPids])]
  const products = await Promise.all(pids.map(id => stripe.products.retrieve(id).catch(() => null)))
  const nameOf = new Map(products.filter(Boolean).map(p => [p.id, p.name]))

  // Stripe-Dashboard schließt zur Kündigung markierte Abos aus MRR + aktiver Zählung aus
  const billing = activeSubs.data.filter(s => !s.cancel_at_period_end)

  const byApp = emptyByApp()
  let currency = 'eur'
  for (const sub of billing) {
    const item = sub.items.data[0]
    const price = item?.price
    if (!price) continue
    currency = price.currency ?? currency
    const pid = typeof price.product === 'string' ? price.product : null
    const app = classifyApp((pid && nameOf.get(pid)) ?? price.nickname ?? 'Other')
    byApp[app].mrr += monthly(price, item?.quantity ?? 1)
    byApp[app].subs += 1
  }
  for (const sess of oneTimeCur) for (const li of sess.line_items?.data ?? []) {
    const price = li.price
    const pid = price && typeof price.product === 'string' ? price.product : null
    const app = classifyApp((pid && nameOf.get(pid)) ?? price?.nickname ?? li.description ?? 'Other')
    byApp[app].oneTime30d += li.amount_total ?? 0
  }

  const totalMrr = Object.values(byApp).reduce((s, a) => s + a.mrr, 0)
  const totalSubs = billing.length
  const prevSubs = billing.filter(s => s.created < d30).length

  // Umsatztrend: eingenommener Umsatz 0–30d vs 30–60d
  const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) ?? 0), 0)
  const curRev = sum(invCur.data, i => i.amount_paid) + sum(oneTimeCur, s => s.amount_total)
  const prevRev = sum(invPrev.data, i => i.amount_paid) + sum(oneTimePrev, s => s.amount_total)
  const revenueChange = prevRev > 0 ? Math.round(((curRev - prevRev) / prevRev) * 1000) / 10 : null

  return { currency, byApp, totalMrr, totalSubs, prevSubs, subsChange: totalSubs - prevSubs, revenueChange }
}
