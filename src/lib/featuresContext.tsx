/**
 * featuresContext.tsx — 用户功能权限 React Context
 *
 * AuthGate 在验证登录后提供 features 数组，
 * App 和子组件通过 useFeatures() 消费。
 */

import { createContext, useContext, type ReactNode } from "react";

interface FeaturesContextValue {
  /** 用户可访问的功能标识集合。["*"] 表示全部权限 */
  features: Set<string>;
  /** 当前登录用户 */
  userId: string | null;
  /** 用户角色 */
  role: string | null;
}

const defaultContext: FeaturesContextValue = {
  features: new Set<string>(),
  userId: null,
  role: null,
};

const FeaturesContext = createContext<FeaturesContextValue>(defaultContext);

export function FeaturesProvider({
  features,
  userId,
  role,
  children,
}: {
  features: string[];
  userId: string | null;
  role: string | null;
  children: ReactNode;
}) {
  const value: FeaturesContextValue = {
    features: new Set(features),
    userId,
    role,
  };
  return <FeaturesContext.Provider value={value}>{children}</FeaturesContext.Provider>;
}

export function useFeatures(): FeaturesContextValue {
  return useContext(FeaturesContext);
}
