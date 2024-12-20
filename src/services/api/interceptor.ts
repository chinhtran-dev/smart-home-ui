import axios, { AxiosError, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

let isRefreshing = false; // Indicates whether a token refresh is in progress
let failedQueue: Array<{ resolve: (value: any) => void; reject: (reason?: any) => void }> = [];

/**
 * Processes the queue of pending requests during token refresh.
 * Resolves or rejects the queued requests based on the success or failure of the refresh.
 * @param error - The error to reject if the refresh failed.
 * @param token - The new token to use for pending requests if the refresh succeeded.
 */
const processQueue = (error: any, token: string | null = null): void => {
  failedQueue.forEach(({ resolve, reject }) => {
    error ? reject(error) : resolve(token);
  });
  failedQueue = [];
};

/**
 * Adds the `Authorization` header with the current access token to every request.
 * @param config - The request configuration.
 * @returns The modified request configuration.
 */
const onRequest = (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
  const accessToken = tokenService.getLocalAccessToken(); // Retrieve access token from local storage
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
};

/**
 * Logs and rejects any errors that occur during request preparation.
 * @param error - The error encountered while preparing the request.
 * @returns A rejected Promise containing the error.
 */
const onRequestError = (error: AxiosError): Promise<AxiosError> => {
  console.error(`[Request Error] ${error.message}`);
  return Promise.reject(error);
};

/**
 * Returns the API response directly if no errors occur.
 * @param response - The API response.
 * @returns The API response.
 */
const onResponse = (response: AxiosResponse): AxiosResponse => response;

/**
 * Handles errors that occur when refreshing the token fails, logs out the user, and resets state.
 * @param error - The error from the API.
 * @returns A resolved Promise with the error response.
 */
const handleErrorResponse = (error: AxiosError): Promise<any> => {
  tokenService.logout(); // Logs out the user
  isRefreshing = false; // Reset the refresh state
  return Promise.resolve(error.response); // Return the error response
};

/**
 * Refreshes the access token using the refresh token.
 * @param api - Axios instance to make the request.
 * @returns A Promise resolving to the new access token, or rejecting on failure.
 */
const refreshAccessToken = async (): Promise<string | null> => {
  const refreshToken = tokenService.getRefreshToken(); // Retrieve the refresh token from local storage
  if (!refreshToken) {
    throw new Error('Refresh token is missing');
  }

  try {
    const response = await authApi.refreshTokenApi({ refreshToken }); // Make the refresh token API call
    if (response.status === 200) {
      const { accessToken } = response.data; // Extract the new access token
      tokenService.updateToken(response.data); // Update the tokens in local storage
      return accessToken;
    }
    throw new Error('Failed to refresh token');
  } catch (error) {
    handleErrorResponse(error as AxiosError);
    throw error;
  } finally {
    isRefreshing = false; // End the refresh process
  }
};

/**
 * Handles retrying of failed requests after the token has been refreshed.
 * @param originalRequest - The original request that failed due to an expired token.
 * @returns A Promise resolving to the response of the retried request.
 */
const handleRetryQueue = async (
  originalRequest: any
): Promise<AxiosResponse> => {
  return new Promise((resolve, reject) => {
    failedQueue.push({ resolve, reject }); // Add the request to the queue
  })
    .then(token => {
      originalRequest.headers.Authorization = `Bearer ${token}`; // Attach the new token to the original request
      return axios(originalRequest); // Retry the original request
    })
    .catch((err) => Promise.reject(err));
};

/**
 * Sets up Axios interceptors to automatically manage tokens and retry requests.
 * @param api - The Axios instance to attach interceptors to.
 */
const setInterceptor = (api: AxiosInstance): void => {
  // Add an interceptor to attach the access token to each request
  api.interceptors.request.use(onRequest, onRequestError);

  // Add an interceptor to handle responses and manage token refresh if needed
  api.interceptors.response.use(onResponse, async (error: any) => {
    const { response, config } = error;

    // If there is no response or config, propagate the error
    if (!response || !config) {
      return Promise.reject(error);
    }

    const originalRequest = error.config;

    // If the error is related to refresh token or forbidden, handle the error directly
    if (response.status === 403 || originalRequest?.url === 'authentication/refresh-token') {
      return handleErrorResponse(error);
    }

    // If the request hasn't been retried yet, attempt to refresh the token
    if (!originalRequest?._retry) {
      originalRequest._retry = true;

      if (!isRefreshing) {
        isRefreshing = true;

        try {
          const newToken = await refreshAccessToken(); // Fetch a new token
          processQueue(null, newToken); // Process pending requests with the new token
          originalRequest.headers.Authorization = `Bearer ${newToken}`; // Attach the new token
          return api(originalRequest); // Retry the original request
        } catch (e) {
          processQueue(e, null); // Handle failure for queued requests
          return Promise.reject(e);
        }
      }

      // If a refresh is already in progress, queue the request and wait
      return handleRetryQueue(originalRequest);
    }

    // If the request was already retried and failed, propagate the error
    return Promise.reject(error);
  });
};

export default setInterceptor;
