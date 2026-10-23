export function ListingCard({ title, genre, condition }: { id: string; title: string; genre: string; condition: string }) {
  return (<article style={{ border: '1px solid #e5e5e5', borderRadius: 8, padding: '1rem', marginTop: '1rem' }}>
    <h3 style={{ margin: '0 0 .25rem' }}>{title}</h3><p style={{ margin: 0, color: '#555' }}>{genre} · {condition}</p></article>);
}
