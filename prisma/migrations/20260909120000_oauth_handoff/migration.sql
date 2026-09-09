-- CreateTable
CREATE TABLE "identity"."oauth_handoff" (
    "code_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "created" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "oauth_handoff_pkey" PRIMARY KEY ("code_hash")
);

-- CreateIndex
CREATE INDEX "oauth_handoff_user_id_idx" ON "identity"."oauth_handoff"("user_id");

-- CreateIndex
CREATE INDEX "oauth_handoff_expires_at_idx" ON "identity"."oauth_handoff"("expires_at");

-- AddForeignKey
ALTER TABLE "identity"."oauth_handoff" ADD CONSTRAINT "oauth_handoff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

