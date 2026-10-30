package cart

type DBStore struct{ dsn string }

func (d *DBStore) Price(sku string) int { return lookup(d.dsn, sku) }

func lookup(dsn, sku string) int { return len(sku) }
