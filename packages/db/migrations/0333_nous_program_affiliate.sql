-- The Affiliate page (operator 14/11 00:07 BKK, nous_msg:de448bc711204fdb832cf926): every affiliate application and what each approval
-- gives (network, publisher id, commission, cookie days, tracking link, coupons/feed, payout, the Vault handle of its sign-in). Class A.
ALTER TABLE nous_programs DROP CONSTRAINT IF EXISTS nous_programs_page_check;
ALTER TABLE nous_programs ADD CONSTRAINT nous_programs_page_check CHECK (page IN ('startup', 'oll4-funding', 'affiliate'));
ALTER TABLE nous_programs ADD COLUMN affiliate jsonb;
