/**
 * The kernel: types every module may depend on, depending on nothing itself.
 *
 * Nothing here knows about HTTP, Prisma, or any other module. That is what lets
 * a domain layer import it without breaking the rule that domain code imports
 * no framework and no ORM (architecture.md §1).
 */
export * from './result';
export * from './domain-error';
export * from './clock';
export * from './id';
