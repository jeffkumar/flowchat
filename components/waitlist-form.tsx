"use client";

import { useState } from "react";
import Form from "next/form";

import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

const US_STATES = [
  "Alabama",
  "Alaska",
  "Arizona",
  "Arkansas",
  "California",
  "Colorado",
  "Connecticut",
  "Delaware",
  "Florida",
  "Georgia",
  "Hawaii",
  "Idaho",
  "Illinois",
  "Indiana",
  "Iowa",
  "Kansas",
  "Kentucky",
  "Louisiana",
  "Maine",
  "Maryland",
  "Massachusetts",
  "Michigan",
  "Minnesota",
  "Mississippi",
  "Missouri",
  "Montana",
  "Nebraska",
  "Nevada",
  "New Hampshire",
  "New Jersey",
  "New Mexico",
  "New York",
  "North Carolina",
  "North Dakota",
  "Ohio",
  "Oklahoma",
  "Oregon",
  "Pennsylvania",
  "Rhode Island",
  "South Carolina",
  "South Dakota",
  "Tennessee",
  "Texas",
  "Utah",
  "Vermont",
  "Virginia",
  "Washington",
  "West Virginia",
  "Wisconsin",
  "Wyoming",
];

export function WaitlistForm({
  action,
  children,
  defaultEmail = "",
}: {
  action: NonNullable<
    string | ((formData: FormData) => void | Promise<void>) | undefined
  >;
  children: React.ReactNode;
  defaultEmail?: string;
}) {
  const [country, setCountry] = useState<string>("");
  const [state, setState] = useState<string>("");

  return (
    <Form action={action} className="flex flex-col gap-4 px-4 py-6 sm:px-16">
      <div className="flex flex-col gap-2">
        <Label className="font-normal text-muted-foreground" htmlFor="email">
          Email Address
        </Label>

        <Input
          autoComplete="email"
          autoFocus
          className="bg-muted text-md md:text-sm"
          defaultValue={defaultEmail}
          id="email"
          name="email"
          placeholder="user@acme.com"
          required
          type="email"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label
          className="font-normal text-muted-foreground"
          htmlFor="password"
        >
          Password
        </Label>

        <Input
          className="bg-muted text-md md:text-sm"
          id="password"
          name="password"
          required
          type="password"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label
          className="font-normal text-muted-foreground"
          htmlFor="businessName"
        >
          Business Name
        </Label>

        <Input
          className="bg-muted text-md md:text-sm"
          id="businessName"
          name="businessName"
          placeholder="Acme Inc."
          required
          type="text"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label
          className="font-normal text-muted-foreground"
          htmlFor="phoneNumber"
        >
          Phone Number
        </Label>

        <Input
          className="bg-muted text-md md:text-sm"
          id="phoneNumber"
          name="phoneNumber"
          placeholder="+1 (555) 123-4567"
          required
          type="tel"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label className="font-normal text-muted-foreground" htmlFor="address">
          Address
        </Label>

        <Textarea
          className="bg-muted text-md md:text-sm"
          id="address"
          name="address"
          placeholder="123 Main St, City, ZIP Code"
          required
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label className="font-normal text-muted-foreground" htmlFor="country">
          Country <span className="text-destructive">*</span>
        </Label>

        <Select
          required
          value={country}
          onValueChange={(value) => {
            setCountry(value);
            // Reset state when country changes
            if (value !== "USA") {
              setState("");
            }
          }}
        >
          <SelectTrigger className="bg-muted text-md md:text-sm" id="country">
            <SelectValue placeholder="Select a country" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="USA">United States</SelectItem>
            <SelectItem value="Canada">Canada</SelectItem>
            <SelectItem value="Mexico">Mexico</SelectItem>
            <SelectItem value="United Kingdom">United Kingdom</SelectItem>
            <SelectItem value="Australia">Australia</SelectItem>
            <SelectItem value="Germany">Germany</SelectItem>
            <SelectItem value="France">France</SelectItem>
            <SelectItem value="Japan">Japan</SelectItem>
            <SelectItem value="China">China</SelectItem>
            <SelectItem value="India">India</SelectItem>
            <SelectItem value="Brazil">Brazil</SelectItem>
            <SelectItem value="Other">Other</SelectItem>
          </SelectContent>
        </Select>
        <input type="hidden" name="country" value={country} required={!country} />
      </div>

      {country === "USA" && (
        <div className="flex flex-col gap-2">
          <Label className="font-normal text-muted-foreground" htmlFor="state">
            State <span className="text-destructive">*</span>
          </Label>

          <Select
            value={state}
            onValueChange={setState}
            required
          >
            <SelectTrigger className="bg-muted text-md md:text-sm" id="state">
              <SelectValue placeholder="Select a state" />
            </SelectTrigger>
            <SelectContent className="max-h-[280px]">
              {US_STATES.map((stateOption) => (
                <SelectItem key={stateOption} value={stateOption}>
                  {stateOption}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input type="hidden" name="state" value={state} required={country === "USA" && !state} />
        </div>
      )}

      {children}
    </Form>
  );
}
