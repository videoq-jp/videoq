/** Binding-only migration tooling: no public data or administrative endpoint. */
export default {fetch(){return new Response('Not found',{status:404});}};
