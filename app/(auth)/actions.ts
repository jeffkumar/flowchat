"use server";

import { z } from "zod";

import {
  createUser,
  getUser,
  createWaitlistRequest,
  getWaitlistRequestByEmail,
} from "@/lib/db/queries";

import { signIn } from "./auth";

const authFormSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const waitlistFormSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  businessName: z.string().min(1),
  phoneNumber: z.string().min(1),
  address: z.string().min(1),
  country: z.string().min(1),
  state: z.string().optional(),
});

export type LoginActionState = {
  status: "idle" | "in_progress" | "success" | "failed" | "invalid_data";
};

export const login = async (
  _: LoginActionState,
  formData: FormData
): Promise<LoginActionState> => {
  try {
    const validatedData = authFormSchema.parse({
      email: formData.get("email"),
      password: formData.get("password"),
    });

    await signIn("credentials", {
      email: validatedData.email,
      password: validatedData.password,
      redirect: false,
    });

    return { status: "success" };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { status: "invalid_data" };
    }

    return { status: "failed" };
  }
};

export type RegisterActionState = {
  status:
    | "idle"
    | "in_progress"
    | "success"
    | "failed"
    | "user_exists"
    | "invalid_data";
};

export type RequestWaitlistActionState = {
  status: "idle" | "in_progress" | "success" | "failed" | "invalid_data" | "already_exists";
};

export const requestWaitlist = async (
  _: RequestWaitlistActionState,
  formData: FormData
): Promise<RequestWaitlistActionState> => {
  try {
    const validatedData = waitlistFormSchema.parse({
      email: formData.get("email"),
      password: formData.get("password"),
      businessName: formData.get("businessName"),
      phoneNumber: formData.get("phoneNumber"),
      address: formData.get("address"),
      country: formData.get("country"),
      state: formData.get("state") || undefined,
    });

    // Check if user already exists
    const [existingUser] = await getUser(validatedData.email);
    if (existingUser) {
      return { status: "already_exists" };
    }

    // Check if waitlist request already exists
    const existingRequest = await getWaitlistRequestByEmail(validatedData.email);
    if (existingRequest) {
      return { status: "already_exists" };
    }

    await createWaitlistRequest({
      email: validatedData.email,
      password: validatedData.password,
      businessName: validatedData.businessName,
      phoneNumber: validatedData.phoneNumber,
      address: validatedData.address,
      country: validatedData.country,
      state: validatedData.state,
    });

    // Return success - redirect will be handled on client side
    return { status: "success" };
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("Validation error:", error.errors);
      return { status: "invalid_data" };
    }

    console.error("Waitlist request error:", error);
    return { status: "failed" };
  }
};

export const register = async (
  _: RegisterActionState,
  formData: FormData
): Promise<RegisterActionState> => {
  try {
    const validatedData = authFormSchema.parse({
      email: formData.get("email"),
      password: formData.get("password"),
    });

    const [user] = await getUser(validatedData.email);

    if (user) {
      return { status: "user_exists" } as RegisterActionState;
    }

    // Check if waitlist request exists and is approved
    const waitlistRequest = await getWaitlistRequestByEmail(validatedData.email);
    if (!waitlistRequest) {
      return { status: "failed" };
    }

    if (waitlistRequest.status !== "approved") {
      return { status: "failed" };
    }

    // Create user with the password from waitlist request
    await createUser(validatedData.email, validatedData.password);
    await signIn("credentials", {
      email: validatedData.email,
      password: validatedData.password,
      redirect: false,
    });

    return { status: "success" };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { status: "invalid_data" };
    }

    return { status: "failed" };
  }
};
