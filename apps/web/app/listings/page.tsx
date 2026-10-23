import { ListingCard } from '../../components/ListingCard';
import { EmptyState, ErrorState } from '../../components/States';

// Server component: fetches from API; renders loading via loading.tsx, empty and error states explicitly.
export default async function ListingsPage({ searchParams }: { searchParams: { q?: string; genre?: string; page?: string } }) {
  const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  let listings: { id: string; title: string; genre: string; condition: string }[] = [];
  let error: string | null = null;
  try {
    const res = await fetch(`${api}/listings?${new URLSearchParams(searchParams as Record<string, string>)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    listings = Array.isArray(data) ? data : (data.items ?? []);
  } catch (e) { error = e instanceof Error ? e.message : 'Failed to load listings'; }
  if (error) return <ErrorState message={error} />;
  return (<section><h1>Browse comics &amp; manga</h1>
    <form method="get"><input name="q" placeholder="Search titles…" defaultValue={searchParams.q ?? ''} aria-label="Search titles" />
    <select name="genre" defaultValue={searchParams.genre ?? ''} aria-label="Genre"><option value="">All genres</option><option>Manga</option><option>Superhero</option><option>Indie</option></select>
    <button type="submit">Search</button></form>
    {listings.length === 0 ? <EmptyState title="No listings match your search" hint="Try a different genre or check back soon — new donations arrive regularly." /> : listings.map(l => <ListingCard key={l.id} {...l} />)}
  </section>);
}
