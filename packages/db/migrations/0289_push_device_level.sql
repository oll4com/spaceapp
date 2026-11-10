-- N2/R6 (operator 3/11): what reaches each phone. Every device starts on NOUS: what it gets today plus what Nous leaves to the operator.
ALTER TABLE space_push_devices ADD COLUMN IF NOT EXISTS level text NOT NULL DEFAULT 'NOUS' CHECK (level IN ('HANDS', 'NOUS', 'ALL'));
