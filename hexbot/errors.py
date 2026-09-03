"""Public Hexbot error types."""


class HexbotError(Exception):
    def __init__(self, code: int, message: str, data=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class GatewayError(HexbotError):
    """An error returned by an in-process Hermes RPC call."""
