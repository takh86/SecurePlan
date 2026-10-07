-- Infrastructure smoke migration only; no product schema is claimed complete.
CREATE TABLE foundation_probe (
  id integer PRIMARY KEY CHECK (id = 1),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO foundation_probe (id) VALUES (1);
