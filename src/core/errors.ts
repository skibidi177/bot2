/** Base class for expected, user-facing business errors. `code` is stable for UI mapping. */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Không tìm thấy dữ liệu') {
    super('not_found', message, 404);
  }
}

export class PermissionDeniedError extends AppError {
  constructor(message = 'Bạn không có quyền thực hiện thao tác này') {
    super('permission_denied', message, 403);
  }
}

export class OutOfStockError extends AppError {
  readonly productNames: string[];
  constructor(productNames: string[]) {
    super('out_of_stock', `Hết hàng: ${productNames.join(', ')}`, 409);
    this.productNames = productNames;
  }
}

export class OrderStateError extends AppError {
  constructor(message: string) {
    super('order_state', message, 409);
  }
}

export class CouponError extends AppError {
  constructor(message: string) {
    super('coupon_invalid', message, 400);
  }
}

export class PaymentVerificationError extends AppError {
  constructor(message: string) {
    super('payment_verification', message, 409);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Thao tác quá nhanh, vui lòng thử lại sau') {
    super('rate_limited', message, 429);
  }
}
