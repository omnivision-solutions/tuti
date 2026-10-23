-- Groups' conditions name the user's `property` (was `attribute`), and "is one of" is "is any of".
UPDATE "reader_group" SET "conditions" = (
  SELECT coalesce(jsonb_agg(
    (c - 'attribute')
      || CASE WHEN c ? 'attribute' THEN jsonb_build_object('property', c -> 'attribute') ELSE '{}'::jsonb END
      || CASE WHEN c ->> 'op' = 'is_one_of' THEN '{"op": "is_any_of"}'::jsonb ELSE '{}'::jsonb END
    ORDER BY i), '[]'::jsonb)
  FROM jsonb_array_elements("conditions") WITH ORDINALITY AS e(c, i)
)
WHERE jsonb_typeof("conditions") = 'array' AND jsonb_array_length("conditions") > 0;
