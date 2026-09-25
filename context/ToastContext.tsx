import React, { createContext, useContext } from 'react';

const ToastContext = createContext({ showToast: (msg: string) => {} });

export const useToast = () => useContext(ToastContext);

export const ToastProvider = ({ children }: { children: React.ReactNode }) => {
  return (
    <ToastContext.Provider value={{ showToast: (msg) => console.log(msg) }}>
      {children}
    </ToastContext.Provider>
  );
};

export default ToastContext;
