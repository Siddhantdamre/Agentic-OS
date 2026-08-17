import { NangoConnectorClient } from './client';
import { CreateRazorpayInvoicePayload } from './types';

export async function createRazorpayInvoice(
  client: NangoConnectorClient,
  orgId: string,
  payload: CreateRazorpayInvoicePayload
) {
  return client.proxyRequest(orgId, 'razorpay', '/v1/invoices', 'POST', {
    type: 'invoice',
    description: payload.description,
    customer: { email: payload.customerEmail },
    line_items: [{ amount: payload.amountInPaisa, currency: 'INR', name: payload.description, quantity: 1 }],
  });
}
