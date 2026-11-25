/** Disposable namespace retirement only; never deploy to a production Worker. */
export default {fetch(){return new Response(null,{status:410});},queue(batch:{retryAll():void}){batch.retryAll();}};
