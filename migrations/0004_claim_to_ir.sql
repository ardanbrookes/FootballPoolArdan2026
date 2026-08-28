-- Let an acquisition land directly on IR.
--
-- Signing an injured player only made sense if you had a spare active roster
-- spot, even when your IR slot was empty — you had to add them, then move them,
-- and with a full roster that first step was impossible. This records the
-- intent on the claim so the waiver processor can honour it when it runs,
-- hours after the manager has gone to bed.
ALTER TABLE waiver_claims ADD COLUMN to_ir INTEGER NOT NULL DEFAULT 0;
