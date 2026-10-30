export default function handler(req: { query: { slug: string } }, res: { json: (x: unknown) => void }) {
  res.json({ slug: req.query.slug });
}
