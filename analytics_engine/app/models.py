from datetime import datetime
from decimal import Decimal
from ipaddress import IPv4Address, IPv6Address
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class TransactionEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: UUID
    sender_id: int = Field(gt=0, le=1_000_000)
    receiver_id: int = Field(gt=0, le=1_000_000)
    amount: Decimal = Field(gt=0, max_digits=15, decimal_places=2)
    currency: Literal["USD"]
    country: str = Field(pattern=r"^[A-Z]{2}$")
    merchant: str = Field(min_length=1, max_length=100)
    sender_ip: IPv4Address | IPv6Address
    device_id: str = Field(min_length=1, max_length=64)
    transaction_type: Literal["purchase", "transfer"]
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def require_timezone(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("created_at must include a timezone")
        return value

    @model_validator(mode="after")
    def different_participants(self):
        if self.sender_id == self.receiver_id:
            raise ValueError("sender_id and receiver_id must differ")
        return self
