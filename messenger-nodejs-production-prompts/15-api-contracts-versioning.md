# Prompt 15: API Contracts And Versioning

You are an expert API design and backend documentation engineer.

Inspect the current API routes, response helpers, socket events, validation schemas, and docs before changing anything.

## Goal

Create stable API and socket contracts so clients can integrate safely and future changes do not break production apps casually.

## Required Work

- document REST API routes
- document socket events
- standardize response shapes
- standardize error shapes and error codes
- standardize pagination contracts
- standardize date/time format
- standardize ID format
- add API versioning guidance
- add deprecation policy
- add request/response examples

## REST Contract

Use versioned routes:

```txt
/api/v1
```

Success response:

```json
{
  "success": true,
  "data": {},
  "message": "Optional message"
}
```

Error response:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": []
  }
}
```

## Pagination Contract

For message history, use cursor pagination:

```json
{
  "items": [],
  "pageInfo": {
    "nextCursor": "string-or-null",
    "hasNextPage": true
  }
}
```

For admin lists, offset pagination can be acceptable when capped.

## Socket Event Documentation

For each event, document:

- event name
- direction
- auth requirement
- permission/resource requirement
- payload schema
- success response
- error response
- rooms receiving broadcast

## Error Codes

Create stable error codes such as:

```txt
VALIDATION_ERROR
UNAUTHENTICATED
FORBIDDEN
NOT_FOUND
CONFLICT
RATE_LIMITED
TOKEN_EXPIRED
INVALID_REFRESH_TOKEN
CONVERSATION_ACCESS_DENIED
MESSAGE_EDIT_WINDOW_EXPIRED
UPLOAD_TYPE_NOT_ALLOWED
```

## Testing

Add tests for:

- response shape consistency
- error shape consistency
- pagination shape
- OpenAPI/schema generation if used
- socket event validation where practical

## Done Criteria

- API contracts are documented
- socket events are documented
- error codes are centralized
- pagination is consistent
- versioning/deprecation policy exists
