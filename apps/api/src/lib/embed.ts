// Embeddings live in @groundwork/embeddings so the index path (worker) and the
// query path (api) provably share a model. Do not add a second client here.
export { embed, embedBatch, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@groundwork/embeddings";
